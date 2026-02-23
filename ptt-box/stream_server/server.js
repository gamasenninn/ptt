/**
 * Stream Server (Node.js版)
 *
 * Webトランシーバーサーバー
 * - 静的ファイル配信
 * - WebSocketシグナリング
 * - PTT状態管理
 * - P2Pシグナリング中継
 * - PCマイク入力 → P2P送信
 * - P2P受信 → スピーカー出力
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const webpush = require('web-push');
const {
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    useAbsSendTime,
    useSdesMid,
    MediaStreamTrack,
} = require('werift');
const { SerialPort } = require('serialport');

// 設定
const HTTP_PORT = parseInt(process.env.HTTP_PORT) || 9320;
const PTT_TIMEOUT = process.env.PTT_TIMEOUT !== undefined ? parseInt(process.env.PTT_TIMEOUT) : 300000;  // 5分（0で無効化）
const STUN_SERVER = process.env.STUN_SERVER || 'stun:stun.l.google.com:19302';
const MIC_DEVICE = process.env.MIC_DEVICE || 'CABLE Output (VB-Audio Virtual Cable)';
const MIC_VOLUME = parseFloat(process.env.MIC_VOLUME) || 1.0;  // マイク音量倍率（デフォルト1.0）
const MIC_SAMPLE_RATE = parseInt(process.env.MIC_SAMPLE_RATE) || 48000;  // マイク入力サンプルレート
const SPEAKER_DEVICE = process.env.SPEAKER_DEVICE || '';  // 空の場合はシステムデフォルト（ffplay用）
const SPEAKER_DEVICE_ID = process.env.SPEAKER_DEVICE_ID || '0';  // デバイスID（Python用）
const USE_PYTHON_AUDIO = process.env.USE_PYTHON_AUDIO === 'true';  // Python音声出力を使用
const ENABLE_LOCAL_AUDIO = process.env.ENABLE_LOCAL_AUDIO !== 'false';  // デフォルト有効
const ENABLE_SERVER_MIC = process.env.ENABLE_SERVER_MIC !== 'false';  // デフォルト有効
const SERVER_MIC_MODE = process.env.SERVER_MIC_MODE || 'always';  // 'always' or 'ptt'
const RELAY_PORT = process.env.RELAY_PORT || 'COM3';
const RELAY_BAUD_RATE = parseInt(process.env.RELAY_BAUD_RATE) || 9600;
const ENABLE_RELAY = process.env.ENABLE_RELAY !== 'false';  // デフォルト有効
const ICE_RESTART_TIMEOUT = parseInt(process.env.ICE_RESTART_TIMEOUT) || 10000;  // ICE Restart タイムアウト（10秒）
const MAX_ICE_RESTART_ATTEMPTS = 5;  // ICE Restart 最大試行回数
const ICE_RESTART_COOLDOWN = 10000;  // ICE Restart成功後のクールダウン期間（10秒）
const OFFER_TIMEOUT = 10000;  // Offer待ちタイムアウト（10秒）
const FFMPEG_RESTART_HOURS = parseFloat(process.env.FFMPEG_RESTART_HOURS) || 0;  // FFmpeg定期再起動（時間、0=無効）

// ダッシュボード設定
const DASH_PASSWORD = process.env.DASH_PASSWORD || 'admin';
const DASH_SESSION_SECRET = uuidv4();  // サーバー起動ごとに変更

// VAPID設定（Web Push）
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

// ログ設定
const ENABLE_FILE_LOG = process.env.ENABLE_FILE_LOG !== 'false';  // デフォルト有効
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS) || 30;  // ログ保持日数

// 履歴表示設定
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT) || 100;  // 履歴表示件数

// AI Assistant プロキシ設定 (後方互換: 旧WS_URL変数もサポート)
const AI_ASSISTANT_URL = process.env.AI_ASSISTANT_URL || process.env.AI_ASSISTANT_WS_URL?.replace('ws://', 'http://') || 'http://localhost:9321';
const AI_ASSISTANT_TIMEOUT = parseInt(process.env.AI_ASSISTANT_TIMEOUT) || 30000;  // 30秒
const VOSK_WS_URL = process.env.VOSK_WS_URL || 'ws://localhost:9322';  // Vosk認識サーバー

// サービスヘルスチェック設定
const MONITORED_SERVICES = ['vox', 'transcriber', 'assistant'];
const HEALTH_TIMEOUT_MS = 60000;  // 60秒（ハートビート2回分の猶予）
const HEALTH_CHECK_INTERVAL_MS = 30000;  // 30秒ごとにタイムアウトチェック

// ログディレクトリ作成
if (ENABLE_FILE_LOG) {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log('Web Push configured');
}

// 音声設定
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const OPUS_PAYLOAD_TYPE = 111;
const OUTPUT_GAIN_DB = parseFloat(process.env.OUTPUT_GAIN_DB) || 6;  // スピーカー出力ゲイン (dB)

// ICE設定
const iceServers = [{ urls: STUN_SERVER }];

// ========== PTT Manager ==========
class PTTManager {
    constructor() {
        this.currentSpeaker = null;
        this.speakerStartTime = null;
        this.maxTransmitTime = PTT_TIMEOUT;
    }

    requestFloor(clientId) {
        if (this.currentSpeaker === null) {
            this.currentSpeaker = clientId;
            this.speakerStartTime = Date.now();
            return true;
        }
        return false;
    }

    releaseFloor(clientId) {
        if (this.currentSpeaker === clientId) {
            this.currentSpeaker = null;
            this.speakerStartTime = null;
            return true;
        }
        return false;
    }

    checkTimeout() {
        // タイムアウト0は無効化
        if (this.maxTransmitTime <= 0) return null;

        if (this.currentSpeaker && this.speakerStartTime) {
            const elapsed = Date.now() - this.speakerStartTime;
            if (elapsed > this.maxTransmitTime) {
                const timedOutSpeaker = this.currentSpeaker;
                this.currentSpeaker = null;
                this.speakerStartTime = null;
                return timedOutSpeaker;
            }
        }
        return null;
    }

    getState() {
        return this.currentSpeaker ? 'transmitting' : 'idle';
    }
}

// ========== Relay Manager ==========
class RelayManager {
    constructor(portName, baudRate) {
        this.portName = portName;
        this.baudRate = baudRate;
        this.serial = null;
        this.enabled = ENABLE_RELAY;
    }

    async connect() {
        if (!this.enabled) {
            log('Relay disabled');
            return;
        }

        try {
            this.serial = new SerialPort({
                path: this.portName,
                baudRate: this.baudRate
            });

            await new Promise((resolve, reject) => {
                this.serial.on('open', () => {
                    log(`Relay connected: ${this.portName}`);
                    resolve();
                });
                this.serial.on('error', (err) => {
                    log(`Relay error: ${err.message}`);
                    reject(err);
                });
            });
        } catch (e) {
            log(`Relay connection failed: ${e.message}`);
            this.enabled = false;
        }
    }

    turnOn() {
        if (this.serial && this.enabled) {
            this.serial.write('A1');
            log('Relay A ON');
        }
    }

    turnOff() {
        if (this.serial && this.enabled) {
            this.serial.write('A0');
            log('Relay A OFF');
        }
    }

    close() {
        if (this.serial) {
            this.turnOff();
            this.serial.close();
            log('Relay closed');
        }
    }
}

// ========== Client Connection ==========
class ClientConnection {
    constructor(clientId, ws, displayName) {
        this.clientId = clientId;
        this.ws = ws;
        this.displayName = displayName;
        this.pc = null;  // RTCPeerConnection
    }

    send(data) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }
}

// ========== Server ==========
class StreamServer {
    constructor() {
        this.clients = new Map();  // clientId -> ClientConnection
        this.pttManager = new PTTManager();
        this.relayManager = new RelayManager(RELAY_PORT, RELAY_BAUD_RATE);
        this.pushSubscriptions = new Map();  // clientId -> subscription

        // P2P接続（サーバーがクライアントとして参加）
        this.p2pConnections = new Map();  // clientId -> { pc, audioTrack }
        this.serverClientId = 'server';

        // 音声入力（マイク）
        this.ffmpegProcess = null;
        this.rtpSequence = 0;
        this.rtpTimestamp = 0;
        this.rtpSsrc = Math.floor(Math.random() * 0xFFFFFFFF);

        // TTS専用RTPステート（マイク音声と分離）
        this.ttsRtpSequence = 0;
        this.ttsRtpTimestamp = 0;
        this.ttsRtpSsrc = Math.floor(Math.random() * 0xFFFFFFFF);
        this.ttsPlaying = false;  // TTS再生中フラグ（マイク音声を一時停止）

        // ストリーミングTTS用キュー（クライアント別）
        // clientId -> { queue: [{index, frames}], expectedIndex: 0, playing: false }
        this.ttsQueues = new Map();

        // FFmpegドリフト計測
        this.ffmpegStartTime = 0;
        this.ffmpegRestartCount = 0;
        this.avgFrameGap = 0;        // フレーム間隔のEMA (ms) - 参考値
        this.activeFrameCount = 0;   // DTX除外のアクティブフレーム数
        this.lastFrameTime = 0;      // 直前フレームの時刻
        this.oggParserBufferSize = 0; // OGGパーサーバッファサイズ
        // RTPベースの真のドリフト計測
        this.driftBaseTime = 0;      // 計測基準時刻（壁時計）
        this.driftBaseRtpTs = 0;     // 計測基準RTPタイムスタンプ

        // 音声出力（スピーカー）
        this.speakerProcess = null;
        this.oggInitialized = false;
        this.oggPageSequence = 0;
        this.oggGranulePos = 0;
        this.oggSerial = 0x12345678;

        // 録音（WAVファイル保存）
        this.recordingProcess = null;
        this.recordingFilename = null;
        this.recordingOggInitialized = false;
        this.recordingOggPageSequence = 0;
        this.recordingOggGranulePos = 0;
        this.recordingOggSerial = 0x87654321;

        // クライアント名マッピング（clientId → displayName）
        this.clientNamesPath = path.join(__dirname, '..', 'recordings', 'client_names.json');
        this.clientNames = this.loadClientNames();

        // サービスヘルス監視
        this.serviceHealth = new Map();  // serviceName -> { lastSeen: timestamp, status: 'up'|'down'|'unknown' }

        // Express設定
        this.app = express();
        this.server = http.createServer(this.app);

        // 静的ファイル配信
        const clientPath = path.join(__dirname, '..', 'stream_client');
        this.app.use(express.static(clientPath));
        log(`Static files: ${clientPath}`);

        // タブ直接アクセス用リダイレクト（standaloneモード）
        this.app.get('/history', (req, res) => res.redirect('/?tab=history&standalone=1'));
        this.app.get('/admin', (req, res) => res.redirect('/?tab=admin&standalone=1'));

        // JSONパーサー
        this.app.use(express.json());

        // サービスヘルスAPI設定
        this.setupHealthApi();

        // History API設定
        this.setupHistoryApi();

        // ダッシュボードAPI設定
        this.setupDashboardApi();

        // WebSocket設定（noServerモードで複数パス対応）
        this.wss = new WebSocket.Server({ noServer: true });
        this.wss.on('connection', (ws) => this.handleConnection(ws));

        this.voskWss = new WebSocket.Server({ noServer: true });
        this.voskWss.on('connection', (clientWs) => {
            log('[Vosk] Proxy client connected');
            const upstream = new WebSocket(VOSK_WS_URL);

            upstream.on('open', () => {
                log('[Vosk] Upstream connected');
            });

            // Vosk → クライアント（text/binary区別を保持）
            upstream.on('message', (data, isBinary) => {
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(data, { binary: isBinary });
                }
            });

            // クライアント → Vosk（PCM=binary, JSON制御=text）
            clientWs.on('message', (data, isBinary) => {
                if (upstream.readyState === WebSocket.OPEN) {
                    upstream.send(data, { binary: isBinary });
                }
            });

            upstream.on('close', () => {
                log('[Vosk] Upstream disconnected');
                if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
            });

            upstream.on('error', (err) => {
                log('[Vosk] Upstream error: ' + err.message);
                if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
            });

            clientWs.on('close', () => {
                log('[Vosk] Proxy client disconnected');
                if (upstream.readyState === WebSocket.OPEN) upstream.close();
            });

            clientWs.on('error', () => {
                if (upstream.readyState === WebSocket.OPEN) upstream.close();
            });
        });

        // PTTタイムアウトチェッカー
        setInterval(() => this.checkPttTimeout(), 1000);

        // WebSocketハートビート（30秒ごとにping/pong確認）
        setInterval(() => {
            for (const [clientId, client] of this.clients) {
                if (client.isAlive === false) {
                    // 前回のpingにpongが返ってこなかった → 切断
                    log(`Client ${client.displayName} timeout - no pong response`);
                    if (client.ws.readyState === WebSocket.OPEN) {
                        client.ws.terminate();
                    }
                    continue;
                }
                client.isAlive = false;  // falseにしてping送信
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.ping();
                }
            }
        }, 30000);

        // サービスヘルスチェック（30秒ごとにタイムアウト確認）
        setInterval(() => {
            const now = Date.now();
            let changed = false;

            for (const service of MONITORED_SERVICES) {
                const health = this.serviceHealth.get(service);

                if (!health) {
                    // まだ一度もハートビートを受信していない
                    if (!this.serviceHealth.has(service)) {
                        this.serviceHealth.set(service, { lastSeen: 0, status: 'unknown' });
                    }
                    continue;
                }

                // 一度もハートビートを受信していないサービスはunknownのまま
                if (health.lastSeen === 0) continue;

                const elapsed = now - health.lastSeen;
                const newStatus = elapsed > HEALTH_TIMEOUT_MS ? 'down' : 'up';

                if (health.status !== newStatus) {
                    health.status = newStatus;
                    changed = true;

                    if (newStatus === 'down') {
                        log(`[Health] Service DOWN: ${service} (no heartbeat for ${Math.round(elapsed / 1000)}s)`, 'warn');
                    }
                }
            }

            if (changed) {
                this.broadcastHealthStatus();
            }
        }, HEALTH_CHECK_INTERVAL_MS);

        // サーバー起動時刻を記録
        this.startTime = Date.now();

        // 状態監視（5分ごと）
        setInterval(() => {
            const uptime = Math.round((Date.now() - this.startTime) / 60000);
            const mem = process.memoryUsage();
            // RTP状態も記録（長時間稼働時の問題調査用）
            const rtpSeq = this.rtpSequence & 0xFFFF;
            const rtpTs = this.rtpTimestamp >>> 0;
            // P2P接続状態の詳細
            const p2pStates = [];
            for (const [clientId, connInfo] of this.p2pConnections) {
                const client = this.clients.get(clientId);
                const name = client ? client.displayName : clientId.slice(0, 4);
                const state = connInfo.pc ? connInfo.pc.connectionState : 'no-pc';
                p2pStates.push(`${name}:${state}`);
            }
            log(`[Monitor] uptime=${uptime}min, clients=${this.clients.size}, p2p=${this.p2pConnections.size}, push=${this.pushSubscriptions.size}, heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB, rtp=${rtpSeq}/${rtpTs}`);
            if (p2pStates.length > 0) {
                log(`[Monitor] P2P: ${p2pStates.join(', ')}`);
            }

            // 音声健全性ログ
            if (this.ffmpegProcess && this.activeFrameCount > 100 && this.driftBaseTime > 0) {
                const ffmpegUptime = Math.round((Date.now() - this.ffmpegStartTime) / 60000);
                const gapMs = this.avgFrameGap.toFixed(2);

                // RTPベースの真のドリフト計測
                // RTPタイムスタンプ（送信サンプル数）vs 壁時計で音声の実際のずれを計測
                const elapsedMs = Date.now() - this.driftBaseTime;
                const expectedRtpTs = this.driftBaseRtpTs + (elapsedMs * 48);  // 48サンプル/ms @ 48kHz
                const actualRtpTs = this.rtpTimestamp;
                const driftPpm = expectedRtpTs > 0 ? Math.round(((actualRtpTs - expectedRtpTs) / expectedRtpTs) * 1000000) : 0;

                log(`[Audio] rtp_drift=${driftPpm > 0 ? '+' : ''}${driftPpm}ppm, gap=${gapMs}ms, buffer=${this.oggParserBufferSize}B, ffmpeg_uptime=${ffmpegUptime}min`);

                // gap異常検出（サンプルレート誤検出の可能性）
                // 正常範囲: 18-23ms (期待値20ms ± 15%)
                // 異常例: 11ms → 88200Hz誤検出、44ms → 22050Hz誤検出
                if (this.avgFrameGap < 15 || this.avgFrameGap > 26) {
                    log(`[Audio] CRITICAL: gap=${gapMs}ms is abnormal (expected ~20ms), possible sample rate mismatch!`);
                    // 異常なgapは常に再起動（サンプルレート誤検出はFFmpeg再起動で回復する可能性）
                    if (ffmpegUptime >= 1) {  // 起動直後の不安定期間を除外
                        log(`[Audio] Triggering FFmpeg restart due to abnormal gap`);
                        this.restartMicCapture('abnormal_gap');
                    }
                }
                // 注: rtp_driftはUSBデバイスクロックとシステムクロックの差を示す
                // WebRTCのジッターバッファが補正するため、音声品質には影響しない
            }
        }, 300000);  // 5分ごと

        // FFmpeg定期再起動チェック（5分ごと）
        if (FFMPEG_RESTART_HOURS > 0) {
            setInterval(() => {
                if (this.ffmpegProcess && this.ffmpegStartTime) {
                    const elapsed = Date.now() - this.ffmpegStartTime;
                    if (elapsed >= FFMPEG_RESTART_HOURS * 3600000) {
                        log(`FFmpeg periodic restart (${FFMPEG_RESTART_HOURS}h elapsed)`);
                        this.restartMicCapture('periodic');
                    }
                }
            }, 300000);  // 5分ごとにチェック
        }

        // マイクキャプチャのハング検知（10秒ごと）
        setInterval(() => {
            if (this.ffmpegProcess && this.lastMicDataTime) {
                const elapsed = Date.now() - this.lastMicDataTime;
                if (elapsed > 10000) {
                    log(`Mic capture appears hung (no data for ${Math.round(elapsed / 1000)}s), restarting...`);
                    this.stopMicCapture();
                    // USBデバイス解放を待ってから再起動（即時再起動するとdshow交渉が不安定になる）
                    setTimeout(() => {
                        this.micStoppedIntentionally = false;
                        this.startMicCapture();
                    }, 100);
                }
            }
        }, 10000);  // 10秒ごと
    }

    async start() {
        // リレー接続
        await this.relayManager.connect();

        // Python音声出力プロセスを常駐起動（USE_PYTHON_AUDIO時のみ）
        if (ENABLE_LOCAL_AUDIO && USE_PYTHON_AUDIO) {
            this.startSpeakerOutput();
        }

        // WebSocket upgradeハンドラ（パスベースルーティング）
        this.server.on('upgrade', (request, socket, head) => {
            const { pathname } = new URL(request.url, 'http://localhost');
            if (pathname === '/ws') {
                this.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.wss.emit('connection', ws, request);
                });
            } else if (pathname === '/vosk/ws') {
                this.voskWss.handleUpgrade(request, socket, head, (ws) => {
                    this.voskWss.emit('connection', ws, request);
                });
            } else {
                socket.destroy();
            }
        });

        this.server.listen(HTTP_PORT, () => {
            log(`Server started on http://localhost:${HTTP_PORT}`);
        });
    }

    // ========== サービスヘルスAPI ==========
    setupHealthApi() {
        // POST /api/health/beat - サービスからのハートビート受信
        this.app.post('/api/health/beat', (req, res) => {
            const { service } = req.body;

            if (!MONITORED_SERVICES.includes(service)) {
                return res.status(400).json({ error: 'Unknown service' });
            }

            const wasDown = this.serviceHealth.get(service)?.status === 'down';

            this.serviceHealth.set(service, {
                lastSeen: Date.now(),
                status: 'up'
            });

            // 復旧時に通知
            if (wasDown) {
                log(`[Health] Service recovered: ${service}`);
                this.broadcastHealthStatus();
            }

            res.json({ success: true });
        });

        // GET /api/health - ヘルス状態取得（認証不要、外部監視ツール用）
        this.app.get('/api/health', (req, res) => {
            const status = {};
            let allUp = true;

            for (const service of MONITORED_SERVICES) {
                const health = this.serviceHealth.get(service);
                status[service] = health?.status || 'unknown';
                if (status[service] !== 'up') allUp = false;
            }

            res.json({
                overall: allUp ? 'healthy' : 'degraded',
                services: status,
                timestamp: new Date().toISOString()
            });
        });
    }

    // 全クライアントにヘルス状態を配信
    broadcastHealthStatus() {
        const status = {};
        for (const [service, health] of this.serviceHealth) {
            status[service] = health.status;
        }

        const msg = {
            type: 'health_status',
            services: status
        };
        for (const client of this.clients.values()) {
            client.send(msg);
        }
    }

    // History API設定
    setupHistoryApi() {
        const recordingsDir = path.join(__dirname, '..', 'recordings');
        const historyDir = path.join(recordingsDir, 'history');

        // GET /api/srt/list - SRTファイル一覧
        this.app.get('/api/srt/list', async (req, res) => {
            try {
                const files = await this.getSrtFileList(recordingsDir);
                res.json({ success: true, files });
            } catch (e) {
                log(`Error listing SRT files: ${e.message}`);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        // GET /api/srt/get - SRTファイル内容取得
        this.app.get('/api/srt/get', async (req, res) => {
            try {
                const filename = req.query.file;
                if (!filename) {
                    return res.status(400).json({ success: false, error: 'file parameter required' });
                }

                const filepath = path.join(recordingsDir, filename);
                if (!fs.existsSync(filepath)) {
                    return res.status(404).json({ success: false, error: 'File not found' });
                }

                const content = fs.readFileSync(filepath, 'utf-8');
                const wavFile = filename.replace('.srt', '.wav');

                res.json({
                    success: true,
                    file: {
                        filename,
                        content,
                        wavFile
                    }
                });
            } catch (e) {
                log(`Error getting SRT file: ${e.message}`);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        // POST /api/srt/save - SRTファイル保存
        this.app.post('/api/srt/save', async (req, res) => {
            try {
                const { file, content } = req.body;
                if (!file || content === undefined) {
                    return res.status(400).json({ success: false, error: 'file and content required' });
                }

                const filepath = path.join(recordingsDir, file);

                // バックアップ作成
                if (fs.existsSync(filepath)) {
                    if (!fs.existsSync(historyDir)) {
                        fs.mkdirSync(historyDir, { recursive: true });
                    }
                    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
                    const backupName = file.replace('.srt', `_${timestamp}.srt`);
                    fs.copyFileSync(filepath, path.join(historyDir, backupName));
                }

                fs.writeFileSync(filepath, content, 'utf-8');
                res.json({ success: true });
            } catch (e) {
                log(`Error saving SRT file: ${e.message}`);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        // GET /api/audio - WAVファイル配信（Range対応）
        this.app.get('/api/audio', async (req, res) => {
            try {
                const filename = req.query.file;
                if (!filename) {
                    return res.status(400).json({ success: false, error: 'file parameter required' });
                }

                const filepath = path.join(recordingsDir, filename);
                if (!fs.existsSync(filepath)) {
                    return res.status(404).json({ success: false, error: 'File not found' });
                }

                const stat = fs.statSync(filepath);
                const fileSize = stat.size;
                const range = req.headers.range;

                if (range) {
                    const parts = range.replace(/bytes=/, '').split('-');
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                    const chunkSize = end - start + 1;

                    res.writeHead(206, {
                        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunkSize,
                        'Content-Type': 'audio/wav'
                    });

                    fs.createReadStream(filepath, { start, end }).pipe(res);
                } else {
                    res.writeHead(200, {
                        'Content-Length': fileSize,
                        'Content-Type': 'audio/wav'
                    });
                    fs.createReadStream(filepath).pipe(res);
                }
            } catch (e) {
                log(`Error streaming audio: ${e.message}`);
                res.status(500).json({ success: false, error: e.message });
            }
        });
    }

    // ========== ダッシュボードAPI ==========
    setupDashboardApi() {
        // セッショントークン管理
        this.dashSessions = new Set();

        // 認証チェックミドルウェア
        const requireAuth = (req, res, next) => {
            const token = req.headers['x-dash-token'] || req.query.token;
            if (token && this.dashSessions.has(token)) {
                next();
            } else {
                res.status(401).json({ success: false, error: 'Unauthorized' });
            }
        };

        // ログイン
        this.app.post('/api/dash/login', (req, res) => {
            const { password } = req.body;
            if (password === DASH_PASSWORD) {
                const token = uuidv4();
                this.dashSessions.add(token);
                log(`Dashboard login successful`);
                res.json({ success: true, token });
            } else {
                log(`Dashboard login failed`);
                res.status(401).json({ success: false, error: 'Invalid password' });
            }
        });

        // ログアウト
        this.app.post('/api/dash/logout', requireAuth, (req, res) => {
            const token = req.headers['x-dash-token'] || req.query.token;
            this.dashSessions.delete(token);
            res.json({ success: true });
        });

        // サーバー状態
        this.app.get('/api/dash/status', requireAuth, (req, res) => {
            const mem = process.memoryUsage();
            const uptime = Math.round((Date.now() - this.startTime) / 1000);
            res.json({
                success: true,
                status: {
                    uptime,
                    uptimeFormatted: this.formatUptime(uptime),
                    memory: {
                        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
                        heapTotal: Math.round(mem.heapTotal / 1024 / 1024)
                    },
                    clientCount: this.clients.size,
                    p2pCount: this.p2pConnections.size,
                    speakerProcess: this.speakerProcess ? 'running' : 'stopped',
                    audio: {
                        ffmpegRunning: !!this.ffmpegProcess,
                        ffmpegUptimeMin: this.ffmpegStartTime ? Math.round((Date.now() - this.ffmpegStartTime) / 60000) : 0,
                        ffmpegRestartCount: this.ffmpegRestartCount,
                        avgFrameGapMs: parseFloat(this.avgFrameGap.toFixed(2)),
                        // RTPベースの真のドリフト（壁時計 vs RTPタイムスタンプ）
                        rtpDriftPpm: this.driftBaseTime > 0 ? (() => {
                            const elapsedMs = Date.now() - this.driftBaseTime;
                            const expectedRtpTs = this.driftBaseRtpTs + (elapsedMs * 48);
                            return Math.round(((this.rtpTimestamp - expectedRtpTs) / expectedRtpTs) * 1000000);
                        })() : 0,
                        oggBufferSize: this.oggParserBufferSize
                    },
                    // サービスヘルス状態
                    services: (() => {
                        const services = {};
                        for (const service of MONITORED_SERVICES) {
                            const health = this.serviceHealth.get(service);
                            services[service] = health?.status || 'unknown';
                        }
                        return services;
                    })()
                }
            });
        });

        // クライアント一覧
        this.app.get('/api/dash/clients', requireAuth, (req, res) => {
            const clients = [];
            for (const [clientId, client] of this.clients) {
                const p2pConn = this.p2pConnections.get(clientId);
                clients.push({
                    clientId,
                    displayName: client.displayName,
                    p2pState: p2pConn ? p2pConn.pc.connectionState : 'none'
                });
            }
            res.json({ success: true, clients });
        });

        // PTT状態
        this.app.get('/api/dash/ptt', requireAuth, (req, res) => {
            const speaker = this.pttManager.currentSpeaker;
            let speakerName = null;
            if (speaker) {
                if (speaker === this.serverClientId) {
                    speakerName = 'Server (PC Mic)';
                } else if (speaker === 'external') {
                    speakerName = '外部デバイス';
                } else {
                    const client = this.clients.get(speaker);
                    speakerName = client ? client.displayName : 'Unknown';
                }
            }
            res.json({
                success: true,
                ptt: {
                    state: this.pttManager.getState(),
                    speaker,
                    speakerName,
                    startTime: this.pttManager.speakerStartTime
                }
            });
        });

        // PTT強制解放
        this.app.post('/api/dash/ptt/release', requireAuth, (req, res) => {
            const speaker = this.pttManager.currentSpeaker;
            if (speaker) {
                this.pttManager.currentSpeaker = null;
                this.pttManager.speakerStartTime = null;
                this.relayManager.turnOff();
                if (ENABLE_LOCAL_AUDIO) {
                    if (USE_PYTHON_AUDIO) {
                        this.pauseSpeakerOutput();
                    } else {
                        this.stopSpeakerOutput();
                    }
                }
                this.stopRecording();
                this.broadcastPttStatus();
                log(`PTT force released by dashboard (was: ${speaker})`);
                res.json({ success: true, message: `PTT released from ${speaker}` });
            } else {
                res.json({ success: true, message: 'No active PTT' });
            }
        });

        // クライアント強制切断
        this.app.post('/api/dash/clients/:clientId/disconnect', requireAuth, (req, res) => {
            const { clientId } = req.params;
            const client = this.clients.get(clientId);

            if (!client) {
                return res.status(404).json({ success: false, error: 'Client not found' });
            }

            log(`Client ${client.displayName} (${clientId}) disconnected by dashboard`);

            // WebSocketを閉じる（handleDisconnectが自動的に呼ばれる）
            client.ws.close(1000, 'Disconnected by administrator');

            res.json({ success: true, message: `Disconnected: ${client.displayName}` });
        });

        // サーバー再起動（pm2経由）
        this.app.post('/api/dash/restart', requireAuth, (req, res) => {
            log('Server restart requested via dashboard');
            res.json({ success: true, message: 'Restarting server...' });

            // クリーンアップ後に終了（pm2が再起動）
            setTimeout(() => {
                this.relayManager.close();
                this.stopMicCapture();
                this.stopSpeakerOutput();
                process.exit(0);
            }, 500);
        });

        // VOX連携API（vox_ptt_record.pyから呼び出される）
        this.app.post('/api/vox/on', (req, res) => {
            // Webクライアントが送信中でなければPTT取得
            if (this.pttManager.requestFloor('external')) {
                this.broadcastPttStatus();
                log('VOX ON: external device transmitting');
                res.json({ success: true });
            } else {
                log('VOX ON denied: floor busy');
                res.json({ success: false, reason: 'floor_busy' });
            }
        });

        this.app.post('/api/vox/off', (req, res) => {
            if (this.pttManager.releaseFloor('external')) {
                this.broadcastPttStatus();
                log('VOX OFF: external device stopped');
                res.json({ success: true });
            } else {
                res.json({ success: false });
            }
        });

        // TTS音声をWebRTC経由で特定クライアントに送信
        // ai_assistant.py から呼び出される（一括送信形式）
        this.app.post('/api/tts_audio', express.raw({ type: 'application/octet-stream', limit: '5mb' }), (req, res) => {
            const targetClientId = req.headers['x-target-client'];
            const frameCount = parseInt(req.headers['x-frame-count'] || '0', 10);

            if (!targetClientId) {
                return res.status(400).json({ success: false, error: 'X-Target-Client header required' });
            }

            const batchData = req.body;
            if (!batchData || batchData.length === 0) {
                return res.status(400).json({ success: false, error: 'No audio data' });
            }

            // バッチデータからOpusフレームを解析
            // フォーマット: [2バイト長さ][フレームデータ][2バイト長さ][フレームデータ]...
            const frames = [];
            let pos = 0;
            while (pos + 2 <= batchData.length) {
                const frameLen = batchData.readUInt16BE(pos);
                pos += 2;
                if (pos + frameLen > batchData.length) break;
                frames.push(batchData.slice(pos, pos + frameLen));
                pos += frameLen;
            }

            if (frames.length === 0) {
                return res.status(400).json({ success: false, error: 'No frames parsed' });
            }

            log(`TTS配信開始: ${frames.length}フレーム -> ${targetClientId}`);

            // TTS再生中はマイク音声を一時停止
            this.ttsPlaying = true;

            // 20ms間隔でフレームを送信（非同期）
            // マイクと同じRTPステートを使用するためリセット不要
            const server = this;
            let frameIndex = 0;
            const sendNextFrame = () => {
                if (frameIndex >= frames.length) {
                    server.ttsPlaying = false;  // TTS終了、マイク再開
                    log(`TTS配信完了: ${frames.length}フレーム -> ${targetClientId}`);
                    return;
                }

                const sent = server.sendOpusToClient(frames[frameIndex], targetClientId);
                if (!sent) {
                    server.ttsPlaying = false;  // TTS中断、マイク再開
                    log(`TTS配信中断: クライアント切断 (${frameIndex}/${frames.length})`, 'warning');
                    return;
                }

                frameIndex++;
                setTimeout(sendNextFrame, 20);  // 20msごとに次のフレーム
            };

            // 最初のフレームを即座に送信開始
            sendNextFrame();

            res.json({ success: true, frames: frames.length });
        });

        // TTS音声を全クライアントに送信（ウェイクワード配信用）
        this.app.post('/api/tts_audio_broadcast', express.raw({ type: 'application/octet-stream', limit: '1mb' }), (req, res) => {
            const opusData = req.body;
            if (!opusData || opusData.length === 0) {
                return res.status(400).json({ success: false, error: 'No audio data' });
            }

            const sentCount = this.sendOpusToAllClients(opusData);
            res.json({ success: true, sentCount });
        });

        // ストリーミングTTS: キュー付きTTS音声（文単位）
        this.app.post('/api/tts_audio_queued', express.raw({ type: 'application/octet-stream', limit: '5mb' }), (req, res) => {
            const targetClientId = req.headers['x-target-client'];
            const sentenceIndex = parseInt(req.headers['x-sentence-index'] || '0', 10);
            const frameCount = parseInt(req.headers['x-frame-count'] || '0', 10);

            if (!targetClientId) {
                return res.status(400).json({ success: false, error: 'X-Target-Client header required' });
            }

            const batchData = req.body;
            if (!batchData || batchData.length === 0) {
                return res.status(400).json({ success: false, error: 'No audio data' });
            }

            // バッチデータからOpusフレームを解析
            const frames = [];
            let pos = 0;
            while (pos + 2 <= batchData.length) {
                const frameLen = batchData.readUInt16BE(pos);
                pos += 2;
                if (pos + frameLen > batchData.length) break;
                frames.push(batchData.slice(pos, pos + frameLen));
                pos += frameLen;
            }

            if (frames.length === 0) {
                return res.status(400).json({ success: false, error: 'No frames parsed' });
            }

            // クライアントキューを取得または作成
            if (!this.ttsQueues.has(targetClientId)) {
                this.ttsQueues.set(targetClientId, {
                    queue: [],
                    expectedIndex: 0,
                    playing: false
                });
            }

            const clientQueue = this.ttsQueues.get(targetClientId);
            clientQueue.queue.push({ index: sentenceIndex, frames });

            log(`TTS キュー追加: sentence[${sentenceIndex}] ${frames.length}フレーム -> ${targetClientId} (queue=${clientQueue.queue.length})`);

            // 次の文を再生開始
            this.processTtsQueue(targetClientId);

            res.json({ success: true, frames: frames.length, sentenceIndex });
        });

        // ストリーミングTTS: スキップ通知（TTS生成失敗時）
        this.app.post('/api/tts_skip', (req, res) => {
            const { clientId, index } = req.body;

            if (!clientId || index === undefined) {
                return res.status(400).json({ success: false, error: 'clientId and index required' });
            }

            const clientQueue = this.ttsQueues.get(clientId);
            if (clientQueue && clientQueue.expectedIndex === index) {
                log(`TTS スキップ: sentence[${index}] -> ${clientId}`);
                clientQueue.expectedIndex++;
                this.processTtsQueue(clientId);
            }

            res.json({ success: true });
        });

        // 音声入力テキスト整形 (AI Assistantプロキシ)
        this.app.post('/api/refine', async (req, res) => {
            try {
                const response = await fetch(`${AI_ASSISTANT_URL}/refine`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(req.body),
                    signal: AbortSignal.timeout(AI_ASSISTANT_TIMEOUT)
                });
                const data = await response.json();
                res.json(data);
            } catch (e) {
                log('Refine proxy error: ' + e.message);
                res.status(502).json({ error: 'AI service unavailable' });
            }
        });

        // AI Assistant ストリーミングクエリ (HTTP SSEプロキシ)
        // WebSocket不要でクライアントから直接SSEを受信可能
        this.app.post('/api/ai/query_stream', async (req, res) => {
            const { query, tts_mode, session_id } = req.body;
            if (!query) {
                return res.status(400).json({ error: 'Empty query' });
            }

            log(`[HTTP] AI query (stream): ${query.substring(0, 50)}... (tts=${tts_mode || 'none'})`);

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            try {
                // SSEストリーミングは長時間かかるため、初回応答のみタイムアウト制御
                // ストリーム開始後は5分まで許容
                const SSE_STREAM_TIMEOUT = 5 * 60 * 1000;
                const response = await fetch(`${AI_ASSISTANT_URL}/query_stream`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query,
                        tts_mode: tts_mode || 'none',
                        session_id: session_id || 'default'
                    }),
                    signal: AbortSignal.timeout(SSE_STREAM_TIMEOUT)
                });

                if (!response.ok) {
                    res.write(`data: ${JSON.stringify({ type: 'error', message: `HTTP ${response.status}: ${response.statusText}` })}\n\n`);
                    res.end();
                    return;
                }

                // Web ReadableStream → Node Readable に変換してパイプ
                const { Readable } = require('stream');
                const nodeStream = Readable.fromWeb(response.body);

                // ストリームエラー時にクライアントにエラーを通知して終了
                nodeStream.on('error', (err) => {
                    log(`[HTTP] AI stream pipe error: ${err.message}`);
                    if (!res.writableEnded) {
                        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
                        res.end();
                    }
                });

                nodeStream.pipe(res);

                // クライアント切断時にアップストリーム接続もクリーンアップ
                req.on('close', () => {
                    nodeStream.destroy();
                });
            } catch (e) {
                const msg = e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED'
                    ? 'AI Assistant not available'
                    : e.message;
                log(`[HTTP] AI stream error: ${msg}`);
                if (!res.headersSent) {
                    res.write(`data: ${JSON.stringify({ type: 'error', message: msg })}\n\n`);
                }
                res.end();
            }
        });

        // AI Assistant TTS停止 (HTTP)
        this.app.post('/api/ai/stop_tts', async (req, res) => {
            log('[HTTP] AI stop TTS requested');
            try {
                const response = await fetch(`${AI_ASSISTANT_URL}/stop_tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: AbortSignal.timeout(AI_ASSISTANT_TIMEOUT)
                });
                if (response.ok) {
                    const data = await response.json();
                    res.json(data);
                } else {
                    res.status(502).json({ stopped: false, error: 'Request failed' });
                }
            } catch (e) {
                log('[HTTP] AI stop TTS error: ' + e.message);
                res.status(502).json({ stopped: false, error: e.message });
            }
        });

        // Edge TTS API (サーバーサイドプロキシ)
        this.app.post('/api/tts/edge', async (req, res) => {
            const { text, voice } = req.body;
            if (!text) {
                return res.status(400).json({ success: false, error: 'text required' });
            }
            try {
                const { EdgeTTS } = require('@andresaya/edge-tts');
                const tts = new EdgeTTS();
                await tts.synthesize(text, voice || 'ja-JP-NanamiNeural');
                const buffer = tts.toBuffer();
                res.set('Content-Type', 'audio/mpeg');
                res.send(buffer);
            } catch (e) {
                log('Edge TTS error: ' + e.message);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        // ダッシュボード静的ファイル
        const dashPath = path.join(__dirname, '..', 'stream_client', 'dash');
        this.app.use('/dash', express.static(dashPath));

        log('Dashboard API configured');
    }

    // 稼働時間フォーマット
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        if (days > 0) return `${days}d ${hours}h ${mins}m`;
        if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
        if (mins > 0) return `${mins}m ${secs}s`;
        return `${secs}s`;
    }

    // SRTファイル一覧取得
    async getSrtFileList(recordingsDir, limit = HISTORY_LIMIT) {
        if (!fs.existsSync(recordingsDir)) {
            return [];
        }

        // まずファイル名だけ取得してソート（高速）
        const srtFiles = fs.readdirSync(recordingsDir)
            .filter(f => f.endsWith('.srt'))
            .map(filename => ({
                filename,
                sortKey: this.extractDatetimeForSort(filename)
            }))
            .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
            .slice(0, limit);  // 最新N件のみ

        // 必要なファイルだけ内容を読み込み
        const files = srtFiles.map(({ filename }) => {
            const filepath = path.join(recordingsDir, filename);
            const content = fs.readFileSync(filepath, 'utf-8');
            const preview = this.getSrtPreview(content);
            const { datetime, datetimeShort } = this.extractDatetimeFromFilename(filename);
            const { source, clientId } = this.extractSourceInfo(filename);
            const displayName = clientId ? this.getClientDisplayName(clientId) : null;

            return {
                filename,
                datetime,
                datetimeShort,
                wavFile: filename.replace('.srt', '.wav'),
                preview,
                source,
                clientId,
                displayName
            };
        });

        return files;
    }

    // ファイル名から日時を抽出
    extractDatetimeFromFilename(filename) {
        // web_20251229_143000_abc123.srt or rec_20251229_143000.srt
        const match = filename.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
        if (match) {
            const [, year, month, day, hour, min, sec] = match;
            return {
                datetime: `${year}-${month}-${day} ${hour}:${min}:${sec}`,
                datetimeShort: `${month}/${day} ${hour}:${min}`
            };
        }
        return { datetime: '-', datetimeShort: '-' };
    }

    // ソート用日時文字列を抽出
    extractDatetimeForSort(filename) {
        const match = filename.match(/(\d{8}_\d{6})/);
        return match ? match[1] : '00000000_000000';
    }

    // ソース情報抽出（web/analog, clientId）
    extractSourceInfo(filename) {
        if (filename.startsWith('web_')) {
            // web_20251229_143000_abc123.srt
            const match = filename.match(/web_\d{8}_\d{6}_([^.]+)\.srt/);
            return {
                source: 'web',
                clientId: match ? match[1] : null
            };
        } else if (filename.startsWith('rec_')) {
            return { source: 'analog', clientId: null };
        }
        return { source: 'unknown', clientId: null };
    }

    // SRTからプレビュー文字列を取得
    getSrtPreview(content) {
        if (!content) return '';

        const lines = content.split('\n');
        const textLines = [];

        for (const line of lines) {
            const trimmed = line.trim();
            // 数字のみの行（シーケンス番号）とタイムスタンプ行をスキップ
            if (!trimmed) continue;
            if (/^\d+$/.test(trimmed)) continue;
            if (/^\d{2}:\d{2}:\d{2}/.test(trimmed)) continue;
            textLines.push(trimmed);
        }

        return textLines.join(' ').substring(0, 50);
    }

    // クライアント名マッピングを読み込み
    loadClientNames() {
        try {
            if (fs.existsSync(this.clientNamesPath)) {
                const data = fs.readFileSync(this.clientNamesPath, 'utf-8');
                const loaded = JSON.parse(data);
                // 旧形式（文字列）と新形式（オブジェクト）の両方に対応
                const normalized = {};
                for (const [id, value] of Object.entries(loaded)) {
                    if (typeof value === 'string') {
                        // 旧形式: "clientId": "name"
                        normalized[id] = { name: value, lastSeen: null };
                    } else {
                        // 新形式: "clientId": { name, lastSeen }
                        normalized[id] = value;
                    }
                }
                return normalized;
            }
        } catch (e) {
            log(`Error loading client names: ${e.message}`);
        }
        return {};
    }

    // クライアント名を保存
    saveClientName(clientId, displayName) {
        try {
            // デフォルト名（Client-xxxx）は保存しない
            if (displayName.startsWith('Client-')) {
                return;
            }

            const today = new Date().toISOString().split('T')[0];  // YYYY-MM-DD
            this.clientNames[clientId] = {
                name: displayName,
                lastSeen: today
            };

            // 90日以上古いエントリをクリーンアップ
            this.cleanupOldClientNames(90);

            const dir = path.dirname(this.clientNamesPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.clientNamesPath, JSON.stringify(this.clientNames, null, 2), 'utf-8');
        } catch (e) {
            log(`Error saving client name: ${e.message}`);
        }
    }

    // 古いエントリをクリーンアップ
    cleanupOldClientNames(daysToKeep) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
        const cutoffStr = cutoffDate.toISOString().split('T')[0];

        let cleaned = 0;
        for (const [id, value] of Object.entries(this.clientNames)) {
            // lastSeenがない（旧形式で変換された）またはcutoffより古い場合は削除
            if (!value.lastSeen || value.lastSeen < cutoffStr) {
                delete this.clientNames[id];
                cleaned++;
            }
        }
        if (cleaned > 0) {
            log(`Cleaned up ${cleaned} old client name entries`);
        }
    }

    // clientIdからdisplayNameを取得
    getClientDisplayName(clientId) {
        const entry = this.clientNames[clientId];
        if (!entry) return null;
        // 新形式と旧形式の両方に対応
        return typeof entry === 'string' ? entry : entry.name;
    }

    // 新規接続
    async handleConnection(ws) {
        const clientId = uuidv4().substring(0, 8);
        const displayName = `Client-${clientId.substring(0, 4)}`;
        const client = new ClientConnection(clientId, ws, displayName);
        this.clients.set(clientId, client);

        log(`Client connected: ${displayName} (${clientId})`);

        // config送信
        client.send({
            type: 'config',
            clientId: clientId,
            iceServers: iceServers,
            vapidPublicKey: VAPID_PUBLIC_KEY || null
        });

        // Offer待ちタイムアウト（WebSocket接続後、Offerが来ない場合に切断）
        client.offerTimeout = setTimeout(() => {
            if (!client.pc && !client.offerProcessing) {
                log(`${client.displayName}: No offer received within ${OFFER_TIMEOUT/1000}s, closing connection`);
                client.ws.close(1000, 'Offer timeout');
            }
        }, OFFER_TIMEOUT);

        // メッセージハンドラ
        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                await this.handleMessage(client, msg);
            } catch (e) {
                logError(`Message error: ${e.message}`);
            }
        });

        // 切断ハンドラ
        ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : '';
            log(`WebSocket closed: ${client.displayName} (code=${code}, reason=${reasonStr})`);
            this.handleDisconnect(client);
        });

        ws.on('error', (err) => {
            logError(`WebSocket error: ${err.message}`);
        });

        // pongハンドラ（ハートビート用）
        ws.on('pong', () => {
            client.isAlive = true;
        });
        client.isAlive = true;  // 初期値
    }

    // メッセージ処理
    async handleMessage(client, msg) {
        switch (msg.type) {
            case 'ai_only':
                // AI専用クライアント（WebRTC不要）
                if (client.offerTimeout) {
                    clearTimeout(client.offerTimeout);
                    client.offerTimeout = null;
                }
                client.aiOnly = true;
                log(`${client.displayName}: AI-only mode`);
                break;

            case 'offer':
                await this.handleOffer(client, msg.sdp);
                break;

            case 'ice-candidate':
                await this.handleIceCandidate(client, msg.candidate);
                break;

            case 'ice_restart_offer':
                await this.handleIceRestartOffer(client, msg.sdp);
                break;

            case 'ptt_request':
                this.handlePttRequest(client);
                break;

            case 'ptt_release':
                this.handlePttRelease(client);
                break;

            case 'set_display_name':
                if (msg.displayName && msg.displayName !== client.displayName) {
                    // 同名の既存クライアントがあれば閉じる（ゴースト接続のクリーンアップ）
                    for (const [otherId, otherClient] of this.clients) {
                        if (otherId !== client.clientId &&
                            otherClient.displayName === msg.displayName) {
                            log(`${msg.displayName}: Closing stale connection ${otherId} (replaced by ${client.clientId})`);
                            otherClient.ws.close(1000, 'Replaced by new connection');
                            break;
                        }
                    }

                    const oldName = client.displayName;
                    client.displayName = msg.displayName;
                    log(`Display name changed: ${oldName} → ${client.displayName}`);
                }
                break;

            // P2Pシグナリング中継
            case 'p2p_offer':
                this.relayP2PMessage(client, msg);
                break;

            case 'p2p_answer':
                // サーバー宛てのP2P Answerか確認
                if (msg.to === this.serverClientId) {
                    await this.handleP2PAnswer(client, msg.sdp);
                } else {
                    this.relayP2PMessage(client, msg);
                }
                break;

            case 'p2p_ice_candidate':
                // サーバー宛てのICE候補か確認
                if (msg.to === this.serverClientId) {
                    await this.handleP2PIceCandidate(client, msg.candidate);
                } else {
                    this.relayP2PMessage(client, msg);
                }
                break;

            case 'push_subscribe':
                this.handlePushSubscribe(client, msg.subscription);
                break;

            case 'client_logs':
                this.handleClientLogs(client, msg);
                break;

            case 'request_p2p_reconnect':
                this.handleP2PReconnectRequest(client);
                break;

            case 'ai_query':
                this.handleAIQuery(client, msg);
                break;

            case 'ai_query_stream':
                this.handleAIQueryStream(client, msg);
                break;

            case 'ai_stop_tts':
                this.handleAIStopTTS(client);
                break;
        }
    }

    // クライアントログをサーバーに保存
    handleClientLogs(client, message) {
        const { logs, lineCount } = message;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeName = (client.displayName || client.clientId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `client-${safeName}-${timestamp}.log`;
        const filepath = path.join(LOG_DIR, filename);

        try {
            fs.writeFileSync(filepath, logs, 'utf-8');
            log(`${client.displayName}: Client logs saved (${lineCount} lines) -> ${filename}`);

            // 成功通知
            client.send({
                type: 'logs_saved',
                filename: filename,
                lineCount: lineCount
            });
        } catch (e) {
            logError(`Failed to save client logs: ${e.message}`);
            client.send({
                type: 'error',
                message: 'ログの保存に失敗しました'
            });
        }
    }

    // ICE Restart後のP2P再接続リクエスト
    handleP2PReconnectRequest(client) {
        log(`${client.displayName}: P2P reconnect requested (after ICE restart)`);

        // ICE Restartタイマーをキャンセル（重要！クライアントがP2P再接続を要求 = ICE restart成功）
        if (client.iceRestartTimer) {
            clearTimeout(client.iceRestartTimer);
            client.iceRestartTimer = null;
            log(`${client.displayName}: ICE restart timer cancelled`);
        }
        client.iceRestartInProgress = false;

        // ICE restart成功後のクールダウン期間を設定
        // この期間中は新しいiceRestartTimerを設定しない（一時的なdisconnected状態を無視）
        client.iceRestartSuccessTime = Date.now();

        // 既存のP2P接続をクリーンアップ
        const p2pConn = this.p2pConnections.get(client.clientId);
        if (p2pConn) {
            // クリーンアップタイマーをキャンセル（重要！）
            if (p2pConn.cleanupTimer) {
                clearTimeout(p2pConn.cleanupTimer);
                p2pConn.cleanupTimer = null;
                log(`${client.displayName}: P2P cleanup timer cancelled`);
            }
            if (p2pConn.pc) {
                p2pConn.pc.onconnectionstatechange = null;
                p2pConn.pc.onicecandidate = null;
                p2pConn.pc.ontrack = null;
                p2pConn.pc.close();
            }
            this.p2pConnections.delete(client.clientId);
            log(`${client.displayName}: Old P2P connection closed`);
        }

        // クライアントリストを再送信
        this.sendClientList(client);

        // サーバーからのP2P接続を再確立
        this.createP2PToClient(client);
    }

    // AI Assistant クエリをプロキシ (HTTP)
    async handleAIQuery(client, msg) {
        const { query, check_wake_word, tts_mode } = msg;

        if (!query) {
            client.send({ type: 'ai_response', error: 'Empty query' });
            return;
        }

        log(`${client.displayName}: AI query: ${query.substring(0, 50)}... (tts=${tts_mode || 'server'})`);

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), AI_ASSISTANT_TIMEOUT);

            const response = await fetch(`${AI_ASSISTANT_URL}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: query,
                    check_wake_word: check_wake_word || false,
                    client_id: client.clientId,  // TTS音声の送信先
                    tts_mode: tts_mode || 'server'  // server/client/none
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            client.send({ type: 'ai_response', ...data });
            log(`${client.displayName}: AI response sent`);

        } catch (e) {
            if (e.name === 'AbortError') {
                client.send({ type: 'ai_response', error: 'AI Assistant timeout' });
            } else if (e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED') {
                log(`AI Assistant connection error: ${e.message}`);
                client.send({ type: 'ai_response', error: 'AI Assistant not available' });
            } else {
                logError(`AI query error: ${e.message}`);
                client.send({ type: 'ai_response', error: e.message });
            }
        }
    }

    // AI Assistant ストリーミングクエリをプロキシ (SSE -> WebSocket)
    async handleAIQueryStream(client, msg) {
        const { query, check_wake_word, tts_mode } = msg;

        if (!query) {
            client.send({ type: 'ai_stream_event', eventType: 'error', message: 'Empty query' });
            return;
        }

        // ストリーミングTTS: 新しいクエリ開始時にキューをリセット
        if (tts_mode === 'server_stream') {
            this.resetTtsQueue(client.clientId);
        }

        log(`${client.displayName}: AI query (stream): ${query.substring(0, 50)}... (tts=${tts_mode || 'server'})`);

        try {
            const response = await fetch(`${AI_ASSISTANT_URL}/query_stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: query,
                    check_wake_word: check_wake_word || false,
                    client_id: client.clientId,
                    tts_mode: tts_mode || 'server'
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // SSEレスポンスをWebSocketに転送
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // SSEイベントを解析
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // 最後の不完全な行を保持

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const eventData = JSON.parse(line.slice(6));
                            // WebSocketクライアントにイベントを転送
                            // eventData.type を eventType にリネームして衝突を防ぐ
                            const { type: eventType, ...rest } = eventData;
                            client.send({
                                type: 'ai_stream_event',
                                eventType: eventType,
                                ...rest
                            });
                        } catch (parseError) {
                            // JSONパースエラーは無視
                        }
                    }
                }
            }

            log(`${client.displayName}: AI stream completed`);

        } catch (e) {
            if (e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED') {
                log(`AI Assistant connection error: ${e.message}`);
                client.send({ type: 'ai_stream_event', eventType: 'error', message: 'AI Assistant not available' });
            } else {
                logError(`AI stream error: ${e.message}`);
                client.send({ type: 'ai_stream_event', eventType: 'error', message: e.message });
            }
        }
    }

    // AI Assistant TTS停止をプロキシ (HTTP)
    async handleAIStopTTS(client) {
        log(`${client.displayName}: AI stop TTS requested`);

        // ストリーミングTTSキューをクリア
        this.clearTtsQueue(client.clientId);
        this.ttsPlaying = false;

        try {
            const response = await fetch(`${AI_ASSISTANT_URL}/stop_tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.ok) {
                const data = await response.json();
                client.send({ type: 'ai_tts_stopped', ...data });
                log(`${client.displayName}: TTS stopped: ${data.stopped}`);
            } else {
                client.send({ type: 'ai_tts_stopped', stopped: false, error: 'Request failed' });
            }
        } catch (e) {
            log(`AI stop TTS error: ${e.message}`);
            client.send({ type: 'ai_tts_stopped', stopped: false, error: e.message });
        }
    }

    // プッシュ通知subscription登録
    handlePushSubscribe(client, subscription) {
        if (!subscription) return;

        // 同じendpoint（同じブラウザ/デバイス）の古いエントリを削除
        const newEndpoint = subscription.endpoint;
        for (const [existingId, existingSub] of this.pushSubscriptions) {
            if (existingId !== client.clientId && existingSub.endpoint === newEndpoint) {
                this.pushSubscriptions.delete(existingId);
            }
        }

        this.pushSubscriptions.set(client.clientId, subscription);
        log(`Push subscription registered: ${client.displayName} (${client.clientId}), total=${this.pushSubscriptions.size}`);
    }

    // プッシュ通知送信（PTT開始時に他クライアントに通知）
    async sendPushNotification(speakerClientId, speakerName) {
        if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

        const payload = JSON.stringify({
            title: 'Webトランシーバー',
            body: `${speakerName} が話しています`,
            url: '/'
        });

        // 接続中のクライアントのendpointを収集（通知不要）
        const connectedEndpoints = new Set();
        for (const [clientId, client] of this.clients) {
            const subscription = this.pushSubscriptions.get(clientId);
            if (subscription) {
                connectedEndpoints.add(subscription.endpoint);
            }
        }

        // 送信済みendpointを追跡（重複送信防止）
        const sentEndpoints = new Set();

        // 接続中でないクライアントにのみ通知
        for (const [clientId, subscription] of this.pushSubscriptions) {
            // 接続中のクライアントはスキップ
            if (connectedEndpoints.has(subscription.endpoint)) continue;
            // 同じendpoint（同じブラウザ）には送信しない
            if (sentEndpoints.has(subscription.endpoint)) continue;
            sentEndpoints.add(subscription.endpoint);

            try {
                await webpush.sendNotification(subscription, payload);
                log(`Push sent to ${clientId}`);
            } catch (error) {
                if (error.statusCode === 410 || error.statusCode === 404) {
                    // subscription無効 → 削除
                    this.pushSubscriptions.delete(clientId);
                    log(`Push subscription removed (expired): ${clientId}`);
                } else {
                    logError(`Push error: ${error.message}`);
                }
            }
        }
    }

    // WebRTC Offer処理
    async handleOffer(client, sdp) {
        // Offer待ちタイムアウトをクリア
        if (client.offerTimeout) {
            clearTimeout(client.offerTimeout);
            client.offerTimeout = null;
        }

        // 二重Offer防止: 既にPeerConnectionがある、または処理中の場合は拒否
        if (client.pc || client.offerProcessing) {
            log(`${client.displayName}: offer rejected (pc=${!!client.pc}, processing=${!!client.offerProcessing})`);
            return;
        }
        client.offerProcessing = true;

        const config = {
            iceServers: iceServers.map(s => ({ urls: s.urls })),
            headerExtensions: {
                audio: [useSdesMid(), useAbsSendTime()]
            }
        };

        client.pc = new RTCPeerConnection(config);

        client.pc.onconnectionstatechange = () => {
            log(`${client.displayName}: connection state = ${client.pc.connectionState}`);

            if (client.pc.connectionState === 'connected') {
                // 接続完了後にclient_list送信
                this.sendClientList(client);
                this.broadcastClientJoined(client);

                // サーバーからクライアントへのP2P接続を確立
                if (ENABLE_LOCAL_AUDIO) {
                    this.createP2PToClient(client);
                }

                // disconnectedタイマーをクリア（回復時）
                if (client.disconnectTimer) {
                    clearTimeout(client.disconnectTimer);
                    client.disconnectTimer = null;
                }

                // ICE Restartタイマーとフラグをクリア（回復時）
                if (client.iceRestartTimer || client.iceRestartInProgress || client.iceRestartAttempts) {
                    if (client.iceRestartTimer) {
                        clearTimeout(client.iceRestartTimer);
                        client.iceRestartTimer = null;
                    }
                    client.iceRestartInProgress = false;
                    client.iceRestartAttempts = 0;  // 試行回数リセット
                    log(`${client.displayName}: ICE restart successful`);
                }
            } else if (client.pc.connectionState === 'disconnected') {
                // WebRTC切断時はICE Restartを待つ（即座に閉じない）
                // ただしICE Restart処理中、またはICE restart成功直後はタイマーを開始しない
                log(`${client.displayName}: WebRTC disconnected, waiting for ICE restart`);

                // ICE restart成功後のクールダウン期間チェック
                const timeSinceSuccess = client.iceRestartSuccessTime
                    ? Date.now() - client.iceRestartSuccessTime
                    : Infinity;

                if (!client.iceRestartTimer && !client.iceRestartInProgress && timeSinceSuccess > ICE_RESTART_COOLDOWN) {
                    // クライアントにICE restart要求を送信（クライアント側で検知できていない場合の対策）
                    client.send({ type: 'request_ice_restart', reason: 'disconnected' });
                    log(`${client.displayName}: ICE restart requested to client`);

                    client.iceRestartTimer = setTimeout(() => {
                        if (client.pc?.connectionState !== 'connected') {
                            log(`${client.displayName}: ICE restart timeout, closing WebSocket`);
                            client.ws.close(1000, 'ICE restart timeout');
                        }
                    }, ICE_RESTART_TIMEOUT);
                } else if (timeSinceSuccess <= ICE_RESTART_COOLDOWN) {
                    log(`${client.displayName}: ICE restart cooldown active (${Math.round(timeSinceSuccess/1000)}s since success)`);
                }
            } else if (client.pc.connectionState === 'failed') {
                // WebRTC接続失敗時もICE Restartを待つ
                // ただしICE restart成功直後はタイマーを開始しない
                log(`${client.displayName}: WebRTC failed, waiting for ICE restart`);

                // ICE restart成功後のクールダウン期間チェック
                const timeSinceSuccess = client.iceRestartSuccessTime
                    ? Date.now() - client.iceRestartSuccessTime
                    : Infinity;

                if (!client.iceRestartTimer && !client.iceRestartInProgress && timeSinceSuccess > ICE_RESTART_COOLDOWN) {
                    // クライアントにICE restart要求を送信
                    client.send({ type: 'request_ice_restart', reason: 'failed' });
                    log(`${client.displayName}: ICE restart requested to client`);

                    client.iceRestartTimer = setTimeout(() => {
                        if (client.pc?.connectionState !== 'connected') {
                            log(`${client.displayName}: ICE restart timeout after failure, closing WebSocket`);
                            client.ws.close(1000, 'ICE restart failed');
                        }
                    }, ICE_RESTART_TIMEOUT);
                } else if (timeSinceSuccess <= ICE_RESTART_COOLDOWN) {
                    log(`${client.displayName}: ICE restart cooldown active (${Math.round(timeSinceSuccess/1000)}s since success)`);
                }
            }
        };

        // ICE候補をクライアントに送信（空候補をフィルタリング）
        client.pc.onicecandidate = (candidate) => {
            if (candidate && candidate.candidate && candidate.candidate.length > 0) {
                client.send({
                    type: 'ice-candidate',
                    candidate: {
                        candidate: candidate.candidate,
                        sdpMid: candidate.sdpMid || '0',
                        sdpMLineIndex: candidate.sdpMLineIndex ?? 0
                    }
                });
            }
        };

        // 受信用トランシーバー
        client.pc.addTransceiver('audio', { direction: 'recvonly' });

        await client.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'offer'));
        log(`${client.displayName}: offer received, creating answer`);
        const answer = await client.pc.createAnswer();
        await client.pc.setLocalDescription(answer);

        log(`${client.displayName}: sending answer`);
        client.send({
            type: 'answer',
            sdp: client.pc.localDescription.sdp
        });
    }

    // ICE候補処理
    async handleIceCandidate(client, candidate) {
        if (client.pc && candidate) {
            try {
                await client.pc.addIceCandidate(new RTCIceCandidate(candidate));
                // ICE restart中は候補追加をログ
                if (client.iceRestartInProgress) {
                    const candidateType = candidate.candidate?.split(' ')[7] || 'unknown';
                    log(`${client.displayName}: ICE candidate added during restart: ${candidateType}`);
                }
            } catch (e) {
                log(`${client.displayName}: ICE candidate error: ${e.message}`);
            }
        }
    }

    // ICE Restart Offer処理（クライアントからの再接続要求）
    async handleIceRestartOffer(client, sdp) {
        // 試行回数をインクリメント
        client.iceRestartAttempts = (client.iceRestartAttempts || 0) + 1;
        log(`ICE restart offer from ${client.displayName} (attempt ${client.iceRestartAttempts}/${MAX_ICE_RESTART_ATTEMPTS})`);

        // 最大試行回数を超えたら切断
        if (client.iceRestartAttempts > MAX_ICE_RESTART_ATTEMPTS) {
            log(`${client.displayName}: too many ICE restart attempts, closing connection`);
            // 既存タイマーをクリア
            if (client.iceRestartTimer) {
                clearTimeout(client.iceRestartTimer);
                client.iceRestartTimer = null;
            }
            client.ws.close(1000, 'ICE restart attempts exceeded');
            return;
        }

        // ICE Restart処理中フラグをセット（タイマー開始を抑制）
        client.iceRestartInProgress = true;

        // タイマークリア
        if (client.iceRestartTimer) {
            clearTimeout(client.iceRestartTimer);
            client.iceRestartTimer = null;
        }

        try {
            // ICE restart前の状態をログ
            log(`${client.displayName}: ICE restart - before: connState=${client.pc.connectionState}, iceState=${client.pc.iceConnectionState}`);

            // クライアントからの新しいOfferを受け入れ、Answerを返す
            await client.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'offer'));
            log(`${client.displayName}: ICE restart - after setRemoteDescription: connState=${client.pc.connectionState}`);

            const answer = await client.pc.createAnswer();
            await client.pc.setLocalDescription(answer);
            log(`${client.displayName}: ICE restart - after setLocalDescription: iceGathering=${client.pc.iceGatheringState}`);

            client.send({
                type: 'ice_restart_answer',
                sdp: client.pc.localDescription.sdp
            });

            log(`ICE restart answer sent to ${client.displayName}`);

            // ICE Restart Answer送信後、新しいタイムアウトタイマーを設定
            // （接続が回復しない場合に備える）
            client.iceRestartTimer = setTimeout(() => {
                if (client.pc?.connectionState !== 'connected') {
                    log(`${client.displayName}: ICE restart timeout after answer, closing WebSocket`);
                    client.ws.close(1000, 'ICE restart timeout');
                }
            }, ICE_RESTART_TIMEOUT);
        } catch (e) {
            logError(`ICE restart failed for ${client.displayName}: ${e.message}`);
            client.iceRestartInProgress = false;
            // 失敗した場合は接続を閉じる
            client.ws.close(1000, 'ICE restart failed');
        }
    }

    // PTTリクエスト
    handlePttRequest(client) {
        if (this.pttManager.requestFloor(client.clientId)) {
            // リレーON（アナログ無線機PTT）
            this.relayManager.turnOn();

            client.send({ type: 'ptt_granted' });
            log(`PTT granted to ${client.displayName}`);
            this.broadcastPttStatus();

            // クライアントからの音声受信のためスピーカー開始
            // Python常駐モードでは起動済みなのでスキップ
            if (ENABLE_LOCAL_AUDIO && !USE_PYTHON_AUDIO) {
                this.startSpeakerOutput();
            }

            // プッシュ通知送信（他のクライアントに通知）
            this.sendPushNotification(client.clientId, client.displayName);

            // 録音開始
            this.startRecording(client.clientId, client.displayName);
        } else {
            const speaker = this.clients.get(this.pttManager.currentSpeaker);
            client.send({
                type: 'ptt_denied',
                speaker: this.pttManager.currentSpeaker,
                speakerName: speaker ? speaker.displayName : 'Unknown'
            });
        }
    }

    // PTTリリース
    handlePttRelease(client) {
        if (this.pttManager.releaseFloor(client.clientId)) {
            // リレーOFF（アナログ無線機PTT）
            this.relayManager.turnOff();

            log(`PTT released by ${client.displayName}`);
            this.broadcastPttStatus();

            // スピーカー一時停止（Python常駐モードではプロセス維持）
            if (ENABLE_LOCAL_AUDIO) {
                if (USE_PYTHON_AUDIO) {
                    this.pauseSpeakerOutput();
                } else {
                    this.stopSpeakerOutput();
                }
            }

            // 録音停止
            this.stopRecording();
        }
    }

    // P2Pメッセージ中継
    relayP2PMessage(from, msg) {
        const target = this.clients.get(msg.to);
        if (target) {
            target.send({
                type: msg.type,
                from: from.clientId,
                sdp: msg.sdp,
                candidate: msg.candidate
            });
        }
    }

    // 切断処理
    handleDisconnect(client) {
        log(`Client disconnected: ${client.displayName}`);

        // 各種タイマークリア
        if (client.disconnectTimer) {
            clearTimeout(client.disconnectTimer);
            client.disconnectTimer = null;
        }
        if (client.offerTimeout) {
            clearTimeout(client.offerTimeout);
            client.offerTimeout = null;
        }
        if (client.iceRestartTimer) {
            clearTimeout(client.iceRestartTimer);
            client.iceRestartTimer = null;
        }

        // PTT解放
        this.pttManager.releaseFloor(client.clientId);

        // WebRTC接続クローズ
        // メインPeerConnectionのハンドラを削除してからclose
        if (client.pc) {
            client.pc.onconnectionstatechange = null;
            client.pc.onicecandidate = null;
            client.pc.close();
        }

        // P2P接続クリーンアップ
        const p2pConn = this.p2pConnections.get(client.clientId);
        if (p2pConn) {
            // クリーンアップタイマーがあればキャンセル
            if (p2pConn.cleanupTimer) {
                clearTimeout(p2pConn.cleanupTimer);
                p2pConn.cleanupTimer = null;
            }
            // RTPサブスクリプションを解除
            if (p2pConn.rtpSubscription) {
                try {
                    p2pConn.rtpSubscription.unsubscribe?.();
                } catch (e) {
                    // ignore
                }
            }
            // P2P PeerConnectionのハンドラを削除してからclose
            if (p2pConn.pc) {
                p2pConn.pc.onconnectionstatechange = null;
                p2pConn.pc.onicecandidate = null;
                p2pConn.pc.ontrack = null;
                p2pConn.pc.close();
            }
            this.p2pConnections.delete(client.clientId);
            log(`P2P connection cleaned up: ${client.clientId}`);
        }

        // クライアント削除
        this.clients.delete(client.clientId);

        // Push subscription削除（WebSocket切断してもsubscriptionは有効なので削除しない）
        // this.pushSubscriptions.delete(client.clientId);

        // 他クライアントに通知
        this.broadcastClientLeft(client);
        this.broadcastPttStatus();
    }

    // PTTタイムアウトチェック
    checkPttTimeout() {
        const timedOut = this.pttManager.checkTimeout();
        if (timedOut) {
            // リレーOFF（タイムアウト時）
            this.relayManager.turnOff();

            log(`PTT timeout: ${timedOut}`);
            this.broadcastPttStatus();

            // スピーカー停止
            if (ENABLE_LOCAL_AUDIO) {
                this.stopSpeakerOutput();
            }

            // 録音停止
            this.stopRecording();
        }
    }

    // ========== ブロードキャスト ==========

    broadcastPttStatus() {
        let speakerName = null;
        if (this.pttManager.currentSpeaker === this.serverClientId) {
            speakerName = 'Server (PC Mic)';
        } else if (this.pttManager.currentSpeaker === 'external') {
            speakerName = '外部デバイス';
        } else {
            const speaker = this.clients.get(this.pttManager.currentSpeaker);
            speakerName = speaker ? speaker.displayName : null;
        }

        const msg = {
            type: 'ptt_status',
            state: this.pttManager.getState(),
            speaker: this.pttManager.currentSpeaker,
            speakerName: speakerName
        };

        for (const client of this.clients.values()) {
            client.send(msg);
        }
    }

    sendClientList(client) {
        const clients = [];
        for (const c of this.clients.values()) {
            if (c.clientId !== client.clientId) {
                clients.push({
                    clientId: c.clientId,
                    displayName: c.displayName
                });
            }
        }
        log(`Sending client_list to ${client.displayName}: ${clients.length} other clients`);
        client.send({
            type: 'client_list',
            clients: clients
        });
    }

    broadcastClientJoined(newClient) {
        const msg = {
            type: 'client_joined',
            clientId: newClient.clientId,
            displayName: newClient.displayName
        };

        for (const client of this.clients.values()) {
            if (client.clientId !== newClient.clientId) {
                client.send(msg);
            }
        }
    }

    broadcastClientLeft(leftClient) {
        const msg = {
            type: 'client_left',
            clientId: leftClient.clientId
        };

        for (const client of this.clients.values()) {
            client.send(msg);
        }
    }

    // ========== P2P接続（サーバー↔クライアント）==========

    async createP2PToClient(client) {
        // 既存のP2P接続があればスキップ（重複防止）
        const existingConn = this.p2pConnections.get(client.clientId);
        if (existingConn && existingConn.pc) {
            const state = existingConn.pc.connectionState;
            if (state === 'connected' || state === 'connecting' || state === 'new') {
                log(`P2P to ${client.displayName}: already exists (${state}), skipping`);
                return;
            }
            // disconnected/failed/closed の場合はクローズしてから再作成
            try {
                existingConn.pc.close();
            } catch (e) {}
            this.p2pConnections.delete(client.clientId);
            log(`P2P to ${client.displayName}: closed old connection (${state})`);
        }

        log(`Creating P2P connection to ${client.displayName}`);

        const config = {
            iceServers: iceServers.map(s => ({ urls: s.urls })),
            headerExtensions: {
                audio: [useSdesMid(), useAbsSendTime()]
            }
        };

        const p2pPc = new RTCPeerConnection(config);

        const connInfo = {
            pc: p2pPc,
            audioTrack: null,
            pendingCandidates: [],
            remoteDescriptionSet: false,
            receivedFrameCount: 0,
            rtpSubscription: null,  // RTPサブスクリプション（クリーンアップ用）
            cleanupTimer: null      // disconnected時のクリーンアップタイマー
        };
        this.p2pConnections.set(client.clientId, connInfo);

        // 接続状態
        const P2P_CLEANUP_TIMEOUT = 15000;  // 15秒（クライアントICE restart 10秒より長め）
        p2pPc.onconnectionstatechange = () => {
            log(`P2P to ${client.displayName}: ${p2pPc.connectionState}`);

            if (p2pPc.connectionState === 'disconnected') {
                // 既存のタイマーがあればクリア
                if (connInfo.cleanupTimer) {
                    clearTimeout(connInfo.cleanupTimer);
                }
                // 15秒後にクリーンアップ（ICE restart猶予期間）
                connInfo.cleanupTimer = setTimeout(() => {
                    if (this.p2pConnections.has(client.clientId) &&
                        p2pPc.connectionState !== 'connected') {
                        log(`P2P to ${client.displayName}: cleanup after timeout`);
                        p2pPc.close();
                        this.p2pConnections.delete(client.clientId);
                    }
                }, P2P_CLEANUP_TIMEOUT);

            } else if (p2pPc.connectionState === 'connected') {
                // 回復したらタイマーキャンセル
                if (connInfo.cleanupTimer) {
                    clearTimeout(connInfo.cleanupTimer);
                    connInfo.cleanupTimer = null;
                    log(`P2P to ${client.displayName}: recovered, timer cancelled`);
                }

            } else if (p2pPc.connectionState === 'failed' || p2pPc.connectionState === 'closed') {
                // 即座に削除
                if (connInfo.cleanupTimer) {
                    clearTimeout(connInfo.cleanupTimer);
                }
                this.p2pConnections.delete(client.clientId);
            }
        };

        // ICE候補（空候補や無効な候補をフィルタリング）
        p2pPc.onicecandidate = (candidate) => {
            if (candidate && candidate.candidate && candidate.candidate.length > 0) {
                client.send({
                    type: 'p2p_ice_candidate',
                    from: this.serverClientId,
                    candidate: {
                        candidate: candidate.candidate,
                        sdpMid: candidate.sdpMid || '0',
                        sdpMLineIndex: candidate.sdpMLineIndex ?? 0
                    }
                });
            }
        };

        // 音声受信（クライアントからの音声）
        p2pPc.ontrack = (event) => {
            log(`P2P received track from ${client.displayName}`);
            const track = event.track;

            // RTPサブスクリプションを保存（クリーンアップ用）
            connInfo.rtpSubscription = track.onReceiveRtp.subscribe((rtp) => {
                // PTTがreceivingの時のみ音声出力
                const pttState = this.pttManager.getState();
                if (pttState !== 'transmitting') return;
                if (this.pttManager.currentSpeaker !== client.clientId) return;

                connInfo.receivedFrameCount++;
                if (connInfo.receivedFrameCount <= 3 || connInfo.receivedFrameCount % 100 === 0) {
                    log(`Received audio from ${client.displayName}: frame ${connInfo.receivedFrameCount}`);
                }

                this.sendOpusToSpeaker(rtp.payload);

                // 録音にも書き込み
                this.writeToRecording(rtp.payload);
            });
        };

        // 送信用トラック追加
        const audioTrack = new MediaStreamTrack({ kind: 'audio' });
        connInfo.audioTrack = audioTrack;
        p2pPc.addTrack(audioTrack);

        // Offer作成
        const offer = await p2pPc.createOffer();
        await p2pPc.setLocalDescription(offer);

        // ICE gathering待機
        await this.waitForIceGathering(p2pPc);

        // Offer送信
        client.send({
            type: 'p2p_offer',
            from: this.serverClientId,
            sdp: p2pPc.localDescription.sdp
        });
    }

    async handleP2PAnswer(client, sdp) {
        const connInfo = this.p2pConnections.get(client.clientId);
        if (!connInfo) return;

        await connInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'answer'));
        connInfo.remoteDescriptionSet = true;

        for (const candidate of connInfo.pendingCandidates) {
            try {
                await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {}
        }
        connInfo.pendingCandidates = [];

        log(`P2P established with ${client.displayName}`);

        // 常時送信モードの場合、最初のP2P接続でマイクを開始
        if (SERVER_MIC_MODE === 'always' && !this.ffmpegProcess) {
            log('Starting always-on mic transmission (DTX enabled)');
            this.startMicCapture();
        }
    }

    async handleP2PIceCandidate(client, candidate) {
        const connInfo = this.p2pConnections.get(client.clientId);
        if (!connInfo) return;

        const iceCandidate = {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex
        };

        if (connInfo.remoteDescriptionSet) {
            try {
                await connInfo.pc.addIceCandidate(new RTCIceCandidate(iceCandidate));
            } catch (e) {}
        } else {
            connInfo.pendingCandidates.push(iceCandidate);
        }
    }

    waitForIceGathering(pc, timeout = 5000) {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }

            const timer = setTimeout(() => {
                pc.onicegatheringstatechange = null;  // タイムアウト時にハンドラをクリア
                resolve();
            }, timeout);

            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    pc.onicegatheringstatechange = null;  // 完了時にハンドラをクリア
                    resolve();
                }
            };
        });
    }

    // ========== マイク入力（送信）==========

    startMicCapture() {
        if (this.ffmpegProcess) return;

        log(`Starting mic capture: ${MIC_DEVICE}`);
        this.micStoppedIntentionally = false;
        this.lastMicDataTime = Date.now();

        // ドリフト計測リセット
        this.ffmpegStartTime = Date.now();
        this.avgFrameGap = 0;
        this.activeFrameCount = 0;
        this.lastFrameTime = 0;
        // RTPベースドリフト計測の基準点（最初のフレーム到着時に設定）
        this.driftBaseTime = 0;
        this.driftBaseRtpTs = 0;

        this.ffmpegProcess = spawn('ffmpeg', [
            // 入力の低遅延設定
            '-fflags', '+nobuffer+flush_packets',
            '-flags', 'low_delay',
            // 入力デバイス
            '-f', 'dshow',
            '-sample_rate', String(MIC_SAMPLE_RATE),  // 入力サンプルレート（デバイスの実レートに合わせる）
            '-audio_buffer_size', '50',  // 50msバッファ（20msだと音割れ）
            '-i', `audio=${MIC_DEVICE}`,
            // 音量調整
            '-af', `volume=${MIC_VOLUME}`,  // 環境変数で設定可能
            // 出力設定
            '-ac', String(CHANNELS),
            '-ar', String(SAMPLE_RATE),
            '-c:a', 'libopus',
            '-b:a', '24k',
            '-frame_duration', String(FRAME_DURATION_MS),
            '-application', 'voip',
            '-vbr', 'on',           // 可変ビットレート
            '-dtx', '1',            // 無音時パケット送信停止
            '-packet_loss', '10',   // パケットロス耐性
            '-page_duration', '20000',
            '-flush_packets', '1',
            '-f', 'ogg',
            'pipe:1'
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // FFmpegのstderrをログに出力（サンプルレート交渉の確認用）
        this.ffmpegProcess.stderr.on('data', (data) => {
            const lines = data.toString().trim().split('\n');
            for (const line of lines) {
                // 入力フォーマット情報をログ出力
                if (line.includes('Input') || line.includes('Stream') || line.includes('Audio:') || line.includes('Hz')) {
                    log(`[FFmpeg] ${line.trim()}`);
                }
            }
        });

        this.ffmpegProcess.on('error', (err) => {
            logError(`FFmpeg error: ${err.message}`);
            this.ffmpegProcess = null;
        });

        this.ffmpegProcess.on('close', (code) => {
            log(`FFmpeg closed with code ${code}`);
            this.ffmpegProcess = null;

            // クラッシュ検知: 意図的な停止でなければ自動再起動
            if (!this.micStoppedIntentionally) {
                log('Mic capture crashed, restarting in 1 second...');
                setTimeout(() => this.startMicCapture(), 1000);
            }
        });

        this.parseOggStream(this.ffmpegProcess.stdout);
    }

    stopMicCapture() {
        if (this.ffmpegProcess) {
            this.micStoppedIntentionally = true;  // 意図的停止フラグ
            // stdoutのリスナーを削除してからkill
            if (this.ffmpegProcess.stdout) {
                this.ffmpegProcess.stdout.removeAllListeners('data');
            }
            this.ffmpegProcess.kill();
            this.ffmpegProcess = null;
            log('Mic capture stopped');
        }
    }

    restartMicCapture(reason) {
        log(`Restarting FFmpeg (reason: ${reason})`);
        this.ffmpegRestartCount++;
        this.stopMicCapture();

        // RTPタイムスタンプ・シーケンスをリセット（ブラウザのジッタバッファがリシンク）
        this.rtpSequence = 0;
        this.rtpTimestamp = 0;

        setTimeout(() => {
            this.micStoppedIntentionally = false;
            this.startMicCapture();
        }, 100);
    }

    measureFrameGap() {
        const now = Date.now();

        // RTPベースドリフト計測: 最初のフレームで基準点を設定
        if (this.driftBaseTime === 0) {
            this.driftBaseTime = now;
            this.driftBaseRtpTs = this.rtpTimestamp;
        }

        if (this.lastFrameTime > 0) {
            const gap = now - this.lastFrameTime;
            // DTX除外: 100ms超はDTXによる無音スキップとみなす
            if (gap < 100) {
                this.activeFrameCount++;
                if (this.avgFrameGap === 0) {
                    this.avgFrameGap = gap;
                } else {
                    // 指数移動平均 (α=0.001, 時定数≈1000フレーム≈20秒)
                    this.avgFrameGap = this.avgFrameGap * 0.999 + gap * 0.001;
                }
            }
        }
        this.lastFrameTime = now;
    }

    parseOggStream(stream) {
        let buffer = Buffer.alloc(0);
        let headersParsed = false;

        stream.on('data', (chunk) => {
            this.lastMicDataTime = Date.now();  // ハング検知用タイムスタンプ更新
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= 27) {
                if (buffer.toString('ascii', 0, 4) !== 'OggS') {
                    buffer = buffer.slice(1);
                    continue;
                }

                const numSegments = buffer.readUInt8(26);
                if (buffer.length < 27 + numSegments) break;

                let payloadSize = 0;
                for (let i = 0; i < numSegments; i++) {
                    payloadSize += buffer.readUInt8(27 + i);
                }

                const pageSize = 27 + numSegments + payloadSize;
                if (buffer.length < pageSize) break;

                const payload = buffer.slice(27 + numSegments, pageSize);

                if (!headersParsed) {
                    if (payload.toString('ascii', 0, 8) === 'OpusHead' ||
                        payload.toString('ascii', 0, 8) === 'OpusTags') {
                        // Skip headers
                    } else {
                        headersParsed = true;
                        this.measureFrameGap();
                        this.sendOpusToClients(payload);
                    }
                } else {
                    this.measureFrameGap();
                    this.sendOpusToClients(payload);
                }

                this.oggParserBufferSize = buffer.length - pageSize;
                buffer = buffer.slice(pageSize);
            }
        });
    }

    createRtpBuffer(payload) {
        const seq = this.rtpSequence++ & 0xFFFF;
        const ts = this.rtpTimestamp >>> 0;

        const header = Buffer.alloc(12);
        header.writeUInt8(0x80, 0);
        header.writeUInt8(OPUS_PAYLOAD_TYPE, 1);
        header.writeUInt16BE(seq, 2);
        header.writeUInt32BE(ts, 4);
        header.writeUInt32BE(this.rtpSsrc, 8);

        this.rtpTimestamp += 960;

        return Buffer.concat([header, payload]);
    }

    sendOpusToClients(opusData) {
        if (opusData.length === 0) return;

        // TTS再生中はマイク音声を送信しない（RTPカウンター競合防止）
        if (this.ttsPlaying) {
            return;
        }

        const currentSpeaker = this.pttManager.currentSpeaker;

        // サーバーマイク音声はサーバーPTTまたは外部デバイス送信中のみ送信
        // アイドル時（currentSpeaker=null）は環境ノイズ防止のため送信しない
        if (currentSpeaker !== this.serverClientId && currentSpeaker !== 'external') {
            if (currentSpeaker && this.lastBlockedSpeaker !== currentSpeaker) {
                log(`[Audio] blocked (echo prevention): speaker=${currentSpeaker}`);
                this.lastBlockedSpeaker = currentSpeaker;
            }
            return;
        }

        // ブロック状態をリセット
        this.lastBlockedSpeaker = null;

        const rtpBuffer = this.createRtpBuffer(opusData);

        let sentCount = 0;
        for (const [clientId, connInfo] of this.p2pConnections) {
            // サーバーPTT中は送信者(server)をスキップ（自分の声が戻るのを防ぐ）
            if (currentSpeaker === clientId) continue;

            if (connInfo.audioTrack && connInfo.pc.connectionState === 'connected') {
                try {
                    connInfo.audioTrack.writeRtp(rtpBuffer);
                    sentCount++;
                } catch (e) {}
            }
        }

        // 診断ログ: 15000パケット（約5分）ごとに送信状況を記録
        this.audioSentCount = (this.audioSentCount || 0) + 1;
        if (this.audioSentCount % 15000 === 0) {
            log(`[Audio] packets=${this.audioSentCount}, sent to ${sentCount}/${this.p2pConnections.size} clients`);
        }
    }

    // TTS専用のRTPバッファ作成（SSRCはマイクと同じ、seq/tsは独立）
    createTtsRtpBuffer(payload) {
        const seq = this.ttsRtpSequence++ & 0xFFFF;
        const ts = this.ttsRtpTimestamp >>> 0;

        const header = Buffer.alloc(12);
        header.writeUInt8(0x80, 0);
        header.writeUInt8(OPUS_PAYLOAD_TYPE, 1);
        header.writeUInt16BE(seq, 2);
        header.writeUInt32BE(ts, 4);
        // 重要: マイクと同じSSRCを使用（クライアントのジッタバッファが認識できるように）
        header.writeUInt32BE(this.rtpSsrc, 8);

        this.ttsRtpTimestamp += 960;  // 48kHz, 20ms = 960 samples

        return Buffer.concat([header, payload]);
    }

    // TTS RTPステートをリセット（新しいTTSセッション開始時）
    resetTtsRtpState() {
        this.ttsRtpSequence = 0;
        this.ttsRtpTimestamp = 0;
    }

    // 特定クライアントにのみOpus音声を送信（TTS用）
    sendOpusToClient(opusData, targetClientId) {
        if (opusData.length === 0) return false;

        const connInfo = this.p2pConnections.get(targetClientId);
        if (!connInfo) {
            log(`[TTS] Target client not found: ${targetClientId}`);
            return false;
        }

        if (!connInfo.audioTrack || connInfo.pc.connectionState !== 'connected') {
            log(`[TTS] Target client not connected: ${targetClientId}`);
            return false;
        }

        // マイクと同じRTPステートを使用（連続したseq/tsでジッタバッファが認識できる）
        const rtpBuffer = this.createRtpBuffer(opusData);

        try {
            connInfo.audioTrack.writeRtp(rtpBuffer);
            return true;
        } catch (e) {
            log(`[TTS] Failed to send to ${targetClientId}: ${e.message}`);
            return false;
        }
    }

    // 全クライアントにOpus音声を送信（将来のウェイクワード配信用）
    sendOpusToAllClients(opusData) {
        if (opusData.length === 0) return 0;

        const rtpBuffer = this.createRtpBuffer(opusData);
        let sentCount = 0;

        for (const [clientId, connInfo] of this.p2pConnections) {
            if (connInfo.audioTrack && connInfo.pc.connectionState === 'connected') {
                try {
                    connInfo.audioTrack.writeRtp(rtpBuffer);
                    sentCount++;
                } catch (e) {}
            }
        }

        return sentCount;
    }

    // ========== ストリーミングTTS キュー処理 ==========

    processTtsQueue(clientId) {
        const clientQueue = this.ttsQueues.get(clientId);
        if (!clientQueue || clientQueue.playing) return;

        // インデックス順にソート
        clientQueue.queue.sort((a, b) => a.index - b.index);

        // 次の期待インデックスがあるか確認
        const nextItem = clientQueue.queue.find(item => item.index === clientQueue.expectedIndex);
        if (!nextItem) return;  // まだ到着していない

        // キューから削除
        clientQueue.queue = clientQueue.queue.filter(item => item.index !== clientQueue.expectedIndex);

        // 再生開始
        clientQueue.playing = true;
        this.ttsPlaying = true;

        log(`TTS 再生開始: sentence[${nextItem.index}] ${nextItem.frames.length}フレーム -> ${clientId}`);

        const server = this;
        let frameIndex = 0;
        const sendNextFrame = () => {
            if (frameIndex >= nextItem.frames.length) {
                // この文の再生完了
                clientQueue.expectedIndex++;
                clientQueue.playing = false;

                if (clientQueue.queue.length > 0) {
                    // 文間の小休止（50ms）後に次の文を再生
                    setTimeout(() => server.processTtsQueue(clientId), 50);
                } else {
                    server.ttsPlaying = false;
                    log(`TTS キュー完了: ${clientId}`);
                }
                return;
            }

            const sent = server.sendOpusToClient(nextItem.frames[frameIndex], clientId);
            if (!sent) {
                // クライアント切断
                clientQueue.playing = false;
                server.ttsPlaying = false;
                log(`TTS 再生中断: クライアント切断 -> ${clientId}`, 'warning');
                return;
            }

            frameIndex++;
            setTimeout(sendNextFrame, 20);  // 20msごとに次のフレーム
        };

        // 最初のフレームを即座に送信開始
        sendNextFrame();
    }

    resetTtsQueue(clientId) {
        this.ttsQueues.set(clientId, {
            queue: [],
            expectedIndex: 0,
            playing: false
        });
    }

    clearTtsQueue(clientId) {
        if (this.ttsQueues.has(clientId)) {
            const clientQueue = this.ttsQueues.get(clientId);
            clientQueue.queue = [];
            clientQueue.expectedIndex = 0;
            clientQueue.playing = false;
        }
    }

    // ========== スピーカー出力（受信）==========

    startSpeakerOutput() {
        if (this.speakerProcess) return;

        if (USE_PYTHON_AUDIO) {
            // Python + sounddevice を使用（デバイス指定可能）
            const pythonScript = path.join(__dirname, '..', 'audio_output.py');

            this.speakerProcess = spawn('uv', ['run', 'python', pythonScript, SPEAKER_DEVICE_ID], {
                stdio: ['pipe', 'ignore', 'pipe'],
                cwd: path.join(__dirname, '..')  // ptt-box ディレクトリで実行
            });

            this.speakerProcess.stderr.on('data', (data) => {
                log(`[audio_output] ${data.toString().trim()}`);
            });

            this.speakerProcess.on('error', (err) => {
                logError(`Python audio error: ${err.message}`);
                this.speakerProcess = null;
            });

            this.speakerProcess.on('close', (code) => {
                log(`Python audio closed (code: ${code})`);
                this.speakerProcess = null;
                this.oggInitialized = false;
                this.oggPageSequence = 0;
                this.oggGranulePos = 0;
            });

            log(`Speaker output started (Python, device=${SPEAKER_DEVICE_ID})`);
        } else {
            // ffplay を使用（従来方式）
            const ffplayArgs = [
                '-f', 'ogg',
                '-i', 'pipe:0',
                '-nodisp',
                '-autoexit',
                '-loglevel', 'error'
            ];

            // 出力デバイスが指定されている場合は追加
            if (SPEAKER_DEVICE) {
                ffplayArgs.push('-audio_device', SPEAKER_DEVICE);
            }

            this.speakerProcess = spawn('ffplay', ffplayArgs, {
                stdio: ['pipe', 'ignore', 'pipe']
            });

            this.speakerProcess.on('error', (err) => {
                logError(`FFplay error: ${err.message}`);
                this.speakerProcess = null;
            });

            this.speakerProcess.on('close', (code) => {
                log(`FFplay closed`);
                this.speakerProcess = null;
                this.oggInitialized = false;
                this.oggPageSequence = 0;
                this.oggGranulePos = 0;
            });

            log('Speaker output started' + (SPEAKER_DEVICE ? `: ${SPEAKER_DEVICE}` : ' (ffplay, default device)'));
        }
    }

    stopSpeakerOutput() {
        if (this.speakerProcess) {
            try {
                this.speakerProcess.stdin.end();
                this.speakerProcess.kill();
            } catch (e) {}
            this.speakerProcess = null;
        }
        this.oggInitialized = false;
        this.oggPageSequence = 0;
        this.oggGranulePos = 0;
        log('Speaker output stopped');
    }

    // PTT終了時用: プロセス維持、OGG状態も維持（連続ストリーム）
    pauseSpeakerOutput() {
        // Python常駐モードではプロセスを維持
        // OGGヘッダーとgranule positionも継続（連続ストリーム）
        log('Speaker output paused (process kept alive)');
    }

    // ========== 録音（WAVファイル保存）==========

    startRecording(clientId, displayName) {
        if (this.recordingProcess) return;

        const fs = require('fs');
        const recordingsDir = path.join(__dirname, '..', 'recordings');
        const tempDir = path.join(__dirname, '..', 'recordings_temp');

        // ディレクトリを作成
        if (!fs.existsSync(recordingsDir)) {
            fs.mkdirSync(recordingsDir, { recursive: true });
        }
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // ファイル名生成: web_YYYYMMDD_HHMMSS_CLIENTID.wav
        const now = new Date();
        const timestamp = now.getFullYear().toString() +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0') + '_' +
            String(now.getHours()).padStart(2, '0') +
            String(now.getMinutes()).padStart(2, '0') +
            String(now.getSeconds()).padStart(2, '0');
        this.recordingFilename = `web_${timestamp}_${clientId}.wav`;
        this.recordingTempPath = path.join(tempDir, `recording_${timestamp}_${clientId}.wav`);
        this.recordingFinalPath = path.join(recordingsDir, this.recordingFilename);

        log(`Recording started: ${this.recordingFilename} (speaker: ${displayName})`);

        // クライアント名をマッピングに保存
        this.saveClientName(clientId, displayName);

        this.recordingProcess = spawn('ffmpeg', [
            '-y',  // 上書き許可
            '-f', 'ogg',
            '-i', 'pipe:0',
            '-ar', '44100',
            '-ac', '1',
            '-acodec', 'pcm_s16le',
            this.recordingTempPath  // 一時ディレクトリに保存
        ], {
            stdio: ['pipe', 'ignore', 'pipe']
        });

        this.recordingProcess.on('error', (err) => {
            logError(`Recording FFmpeg error: ${err.message}`);
            this.recordingProcess = null;
        });

        this.recordingProcess.on('close', (code) => {
            log(`Recording FFmpeg closed (code: ${code})`);
            // PTT終了時にリネームするので、ここではプロセスのクリアのみ
            this.recordingProcess = null;
        });

        // OGG状態リセット
        this.recordingOggInitialized = false;
        this.recordingOggPageSequence = 0;
        this.recordingOggGranulePos = 0;
    }

    stopRecording() {
        const tempPath = this.recordingTempPath;
        const finalPath = this.recordingFinalPath;
        const filename = this.recordingFilename;

        if (this.recordingProcess) {
            const process = this.recordingProcess;
            this.recordingProcess = null;  // 次の録音を開始できるように先にクリア

            try {
                process.stdin.end();
            } catch (e) {}

            // ffmpegプロセス終了後に移動
            process.on('close', () => {
                const fs = require('fs');
                if (tempPath && finalPath && fs.existsSync(tempPath)) {
                    try {
                        fs.copyFileSync(tempPath, finalPath);
                        fs.unlinkSync(tempPath);
                        log(`Recording saved: ${filename}`);
                    } catch (e) {
                        logError(`Failed to move recording: ${e.message}`);
                    }
                }
            });
        }

        this.recordingOggInitialized = false;
        this.recordingOggPageSequence = 0;
        this.recordingOggGranulePos = 0;
        this.recordingTempPath = null;
        this.recordingFinalPath = null;
        this.recordingFilename = null;
    }

    writeToRecording(opusPayload) {
        if (!this.recordingProcess || !this.recordingProcess.stdin.writable) return;

        try {
            if (!this.recordingOggInitialized) {
                // OpusHead
                const idHeader = this.createOpusIdHeader();
                const idPage = this.createRecordingOggPage(idHeader, 0x02, 0);
                this.recordingProcess.stdin.write(idPage);

                // OpusTags
                const commentHeader = this.createOpusCommentHeader();
                const commentPage = this.createRecordingOggPage(commentHeader, 0, 0);
                this.recordingProcess.stdin.write(commentPage);

                this.recordingOggInitialized = true;
            }

            this.recordingOggGranulePos += 960;
            const dataPage = this.createRecordingOggPage(opusPayload, 0, this.recordingOggGranulePos);
            this.recordingProcess.stdin.write(dataPage);
        } catch (e) {}
    }

    createRecordingOggPage(payload, headerType, granulePos) {
        const segmentCount = Math.ceil(payload.length / 255) || 1;
        const segmentTable = [];
        let remaining = payload.length;
        for (let i = 0; i < segmentCount; i++) {
            const size = Math.min(remaining, 255);
            segmentTable.push(size);
            remaining -= size;
        }

        const headerSize = 27 + segmentTable.length;
        const page = Buffer.alloc(headerSize + payload.length);

        page.write('OggS', 0);
        page.writeUInt8(0, 4);
        page.writeUInt8(headerType, 5);
        page.writeBigUInt64LE(BigInt(granulePos), 6);
        page.writeUInt32LE(this.recordingOggSerial, 14);
        page.writeUInt32LE(this.recordingOggPageSequence++, 18);
        page.writeUInt32LE(0, 22);
        page.writeUInt8(segmentTable.length, 26);

        for (let i = 0; i < segmentTable.length; i++) {
            page.writeUInt8(segmentTable[i], 27 + i);
        }

        payload.copy(page, headerSize);

        const crc = this.crc32Ogg(page);
        page.writeUInt32LE(crc, 22);

        return page;
    }

    sendOpusToSpeaker(opusPayload) {
        if (!this.speakerProcess || !this.speakerProcess.stdin.writable) return;

        try {
            if (!this.oggInitialized) {
                // OpusHead
                const idHeader = this.createOpusIdHeader();
                const idPage = this.createOggPage(idHeader, 0x02, 0);
                this.speakerProcess.stdin.write(idPage);

                // OpusTags
                const commentHeader = this.createOpusCommentHeader();
                const commentPage = this.createOggPage(commentHeader, 0, 0);
                this.speakerProcess.stdin.write(commentPage);

                this.oggInitialized = true;
            }

            this.oggGranulePos += 960;
            const dataPage = this.createOggPage(opusPayload, 0, this.oggGranulePos);
            this.speakerProcess.stdin.write(dataPage);
        } catch (e) {}
    }

    createOpusIdHeader() {
        const header = Buffer.alloc(19);
        header.write('OpusHead', 0);
        header.writeUInt8(1, 8);
        header.writeUInt8(CHANNELS, 9);
        header.writeUInt16LE(0, 10);
        header.writeUInt32LE(SAMPLE_RATE, 12);
        header.writeInt16LE(OUTPUT_GAIN_DB * 256, 16);
        header.writeUInt8(0, 18);
        return header;
    }

    createOpusCommentHeader() {
        const vendor = 'stream_server';
        const header = Buffer.alloc(8 + 4 + vendor.length + 4);
        header.write('OpusTags', 0);
        header.writeUInt32LE(vendor.length, 8);
        header.write(vendor, 12);
        header.writeUInt32LE(0, 12 + vendor.length);
        return header;
    }

    createOggPage(payload, headerType, granulePos) {
        const segmentCount = Math.ceil(payload.length / 255) || 1;
        const segmentTable = [];
        let remaining = payload.length;
        for (let i = 0; i < segmentCount; i++) {
            const size = Math.min(remaining, 255);
            segmentTable.push(size);
            remaining -= size;
        }

        const headerSize = 27 + segmentTable.length;
        const page = Buffer.alloc(headerSize + payload.length);

        page.write('OggS', 0);
        page.writeUInt8(0, 4);
        page.writeUInt8(headerType, 5);
        page.writeBigUInt64LE(BigInt(granulePos), 6);
        page.writeUInt32LE(this.oggSerial, 14);
        page.writeUInt32LE(this.oggPageSequence++, 18);
        page.writeUInt32LE(0, 22);
        page.writeUInt8(segmentTable.length, 26);

        for (let i = 0; i < segmentTable.length; i++) {
            page.writeUInt8(segmentTable[i], 27 + i);
        }

        payload.copy(page, headerSize);

        const crc = this.crc32Ogg(page);
        page.writeUInt32LE(crc, 22);

        return page;
    }

    crc32Ogg(data) {
        const table = StreamServer.crcTable;
        let crc = 0;
        for (let i = 0; i < data.length; i++) {
            crc = ((crc << 8) ^ table[((crc >>> 24) ^ data[i]) & 0xFF]) >>> 0;
        }
        return crc;
    }

    static crcTable = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let r = i << 24;
            for (let j = 0; j < 8; j++) {
                r = (r << 1) ^ ((r & 0x80000000) ? 0x04C11DB7 : 0);
            }
            table[i] = r >>> 0;
        }
        return table;
    })();
}

// ========== ユーティリティ ==========
function getLogFilePath() {
    const date = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    return path.join(LOG_DIR, `server-${date}.log`);
}

function cleanupOldLogs() {
    if (!ENABLE_FILE_LOG || LOG_RETENTION_DAYS <= 0) return;

    try {
        const files = fs.readdirSync(LOG_DIR);
        const now = Date.now();
        const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        let deletedCount = 0;

        for (const file of files) {
            if (!file.startsWith('server-') || !file.endsWith('.log')) continue;

            // ファイル名から日付を抽出 (server-YYYY-MM-DD.log)
            const match = file.match(/^server-(\d{4}-\d{2}-\d{2})\.log$/);
            if (!match) continue;

            const fileDate = new Date(match[1]);
            if (isNaN(fileDate.getTime())) continue;

            const age = now - fileDate.getTime();
            if (age > maxAge) {
                const filePath = path.join(LOG_DIR, file);
                fs.unlinkSync(filePath);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            console.log(`[Log Cleanup] Deleted ${deletedCount} old log file(s)`);
        }
    } catch (e) {
        console.error(`[Log Cleanup] Error: ${e.message}`);
    }
}

function writeToLogFile(line) {
    if (!ENABLE_FILE_LOG) return;
    try {
        fs.appendFileSync(getLogFilePath(), line + '\n');
    } catch (e) {
        // ファイル書き込みエラーは無視（コンソールには出力済み）
    }
}

function log(msg) {
    const now = new Date();
    const time = now.toLocaleTimeString();
    const fullTimestamp = now.toISOString();
    console.log(`[${time}] ${msg}`);
    writeToLogFile(`[${fullTimestamp}] ${msg}`);
}

function logError(msg) {
    const now = new Date();
    const time = now.toLocaleTimeString();
    const fullTimestamp = now.toISOString();
    console.error(`[${time}] ERROR: ${msg}`);
    writeToLogFile(`[${fullTimestamp}] ERROR: ${msg}`);
}

// ========== テスト用ユーティリティ関数 ==========
// クラスメソッドと同じロジックをスタンドアロン関数として提供

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
}

function extractDatetimeFromFilename(filename) {
    const match = filename.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (match) {
        const [, year, month, day, hour, min, sec] = match;
        return {
            datetime: `${year}-${month}-${day} ${hour}:${min}:${sec}`,
            datetimeShort: `${month}/${day} ${hour}:${min}`
        };
    }
    return { datetime: '-', datetimeShort: '-' };
}

function extractDatetimeForSort(filename) {
    const match = filename.match(/(\d{8}_\d{6})/);
    return match ? match[1] : '00000000_000000';
}

function extractSourceInfo(filename) {
    if (filename.startsWith('web_')) {
        const match = filename.match(/web_\d{8}_\d{6}_([^.]+)\.srt/);
        return {
            source: 'web',
            clientId: match ? match[1] : null
        };
    } else if (filename.startsWith('rec_')) {
        return { source: 'analog', clientId: null };
    }
    return { source: 'unknown', clientId: null };
}

function getSrtPreview(content) {
    if (!content) return '';

    const lines = content.split('\n');
    const textLines = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/^\d+$/.test(trimmed)) continue;
        if (/^\d{2}:\d{2}:\d{2}/.test(trimmed)) continue;
        textLines.push(trimmed);
    }

    return textLines.join(' ').substring(0, 50);
}

// ========== モジュールエクスポート ==========
// テスト用にエクスポート（本番実行には影響なし）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // 純粋関数
        formatUptime,
        extractDatetimeFromFilename,
        extractDatetimeForSort,
        extractSourceInfo,
        getSrtPreview,
        // クラス（Phase 2以降で使用）
        PTTManager,
        StreamServer
    };
}

// ========== メイン ==========
// テスト実行時はサーバーを起動しない
if (require.main === module) {
    console.log('='.repeat(50));
    console.log('  Stream Server (Node.js)');
    console.log('='.repeat(50));

    if (ENABLE_FILE_LOG) {
        console.log(`File logging: ${LOG_DIR}`);
        console.log(`Log retention: ${LOG_RETENTION_DAYS} days`);

        // 起動時に古いログをクリーンアップ
        cleanupOldLogs();

        // 毎日0時にログクリーンアップを実行
        const now = new Date();
        const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0) - now;
        setTimeout(() => {
            cleanupOldLogs();
            // 以降は24時間ごとに実行
            setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);
        }, msUntilMidnight);
    }

    const server = new StreamServer();
    server.start();

    // 起動ログ
    log('Server started');
    if (MIC_SAMPLE_RATE !== SAMPLE_RATE) {
        log(`Mic input: ${MIC_SAMPLE_RATE}Hz → resampling to ${SAMPLE_RATE}Hz`);
    }
    if (FFMPEG_RESTART_HOURS > 0) {
        log(`FFmpeg periodic restart: every ${FFMPEG_RESTART_HOURS}h`);
    }

    // サーバーマイクモード表示とキーボード制御
    if (ENABLE_SERVER_MIC) {
        console.log('');
        if (SERVER_MIC_MODE === 'always') {
            console.log('Mic mode: ALWAYS ON (DTX enabled - silent when no audio)');
            console.log('  Mic will start automatically when first client connects');
        } else {
            console.log('Mic mode: PTT (press SPACE to transmit)');
        }

        try {
            const readline = require('readline');
            readline.emitKeypressEvents(process.stdin);
            if (process.stdin.setRawMode) {
                process.stdin.setRawMode(true);
            }

            console.log('');
            console.log('Controls:');
            if (SERVER_MIC_MODE === 'ptt') {
                console.log('  [SPACE] - Toggle mic transmission');
            }
            console.log('  [q]     - Quit');
            console.log('');

            let serverTransmitting = false;

            process.stdin.on('keypress', (str, key) => {
                if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
                    log('Shutting down...');
                    server.relayManager.close();
                    server.stopMicCapture();
                    server.stopSpeakerOutput();
                    process.exit(0);
                }

                // PTTモードの時のみスペースキーで制御
                if (SERVER_MIC_MODE === 'ptt' && key.name === 'space') {
                    if (!serverTransmitting) {
                        // サーバーがPTT取得
                        if (server.pttManager.requestFloor(server.serverClientId)) {
                            serverTransmitting = true;
                            log('Server PTT ON - transmitting mic audio');
                            server.startMicCapture();
                            server.broadcastPttStatus();
                        } else {
                            log('PTT denied - someone else is transmitting');
                        }
                    } else {
                        // サーバーがPTTリリース
                        server.pttManager.releaseFloor(server.serverClientId);
                        serverTransmitting = false;
                        log('Server PTT OFF');
                        server.stopMicCapture();
                        server.broadcastPttStatus();
                    }
                }
            });
        } catch (e) {
            console.log('Keyboard input not available');
        }
    }

    // グレースフルシャットダウン
    process.on('SIGINT', () => {
        log('SIGINT received, shutting down...');
        server.relayManager.close();
        server.stopMicCapture();
        server.stopSpeakerOutput();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        log('SIGTERM received, shutting down...');
        server.relayManager.close();
        server.stopMicCapture();
        server.stopSpeakerOutput();
        process.exit(0);
    });
}
