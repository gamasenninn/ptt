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
const SPEAKER_DEVICE = process.env.SPEAKER_DEVICE || '';  // 空の場合はシステムデフォルト（ffplay用）
const SPEAKER_DEVICE_ID = process.env.SPEAKER_DEVICE_ID || '0';  // デバイスID（Python用）
const USE_PYTHON_AUDIO = process.env.USE_PYTHON_AUDIO === 'true';  // Python音声出力を使用
const ENABLE_LOCAL_AUDIO = process.env.ENABLE_LOCAL_AUDIO !== 'false';  // デフォルト有効
const ENABLE_SERVER_MIC = process.env.ENABLE_SERVER_MIC !== 'false';  // デフォルト有効
const SERVER_MIC_MODE = process.env.SERVER_MIC_MODE || 'always';  // 'always' or 'ptt'
const RELAY_PORT = process.env.RELAY_PORT || 'COM3';
const RELAY_BAUD_RATE = parseInt(process.env.RELAY_BAUD_RATE) || 9600;
const ENABLE_RELAY = process.env.ENABLE_RELAY !== 'false';  // デフォルト有効

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
const OUTPUT_GAIN_DB = 6;  // 6dB boost

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

        // Express設定
        this.app = express();
        this.server = http.createServer(this.app);

        // 静的ファイル配信
        const clientPath = path.join(__dirname, '..', 'stream_client');
        this.app.use(express.static(clientPath));
        log(`Static files: ${clientPath}`);

        // JSONパーサー
        this.app.use(express.json());

        // History API設定
        this.setupHistoryApi();

        // ダッシュボードAPI設定
        this.setupDashboardApi();

        // WebSocket設定
        this.wss = new WebSocket.Server({ server: this.server, path: '/ws' });
        this.wss.on('connection', (ws) => this.handleConnection(ws));

        // PTTタイムアウトチェッカー
        setInterval(() => this.checkPttTimeout(), 1000);

        // WebSocketハートビート（30秒ごとにping/pong確認）
        setInterval(() => {
            for (const [clientId, client] of this.clients) {
                if (client.isAlive === false) {
                    // 前回のpingにpongが返ってこなかった → 切断
                    log(`Client ${client.displayName} timeout - no pong response`);
                    client.ws.terminate();
                    continue;
                }
                client.isAlive = false;  // falseにしてping送信
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.ping();
                }
            }
        }, 30000);

        // サーバー起動時刻を記録
        this.startTime = Date.now();

        // 状態監視（5分ごと）
        setInterval(() => {
            const uptime = Math.round((Date.now() - this.startTime) / 60000);
            const mem = process.memoryUsage();
            log(`[Monitor] uptime=${uptime}min, clients=${this.clients.size}, p2p=${this.p2pConnections.size}, push=${this.pushSubscriptions.size}, heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
        }, 300000);  // 5分ごと
    }

    async start() {
        // リレー接続
        await this.relayManager.connect();

        // Python音声出力プロセスを常駐起動（USE_PYTHON_AUDIO時のみ）
        if (ENABLE_LOCAL_AUDIO && USE_PYTHON_AUDIO) {
            this.startSpeakerOutput();
        }

        this.server.listen(HTTP_PORT, () => {
            log(`Server started on http://localhost:${HTTP_PORT}`);
        });
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
                    speakerProcess: this.speakerProcess ? 'running' : 'stopped'
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
    async getSrtFileList(recordingsDir, limit = 30) {
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
                return JSON.parse(data);
            }
        } catch (e) {
            log(`Error loading client names: ${e.message}`);
        }
        return {};
    }

    // クライアント名を保存
    saveClientName(clientId, displayName) {
        try {
            this.clientNames[clientId] = displayName;
            const dir = path.dirname(this.clientNamesPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.clientNamesPath, JSON.stringify(this.clientNames, null, 2), 'utf-8');
        } catch (e) {
            log(`Error saving client name: ${e.message}`);
        }
    }

    // clientIdからdisplayNameを取得
    getClientDisplayName(clientId) {
        return this.clientNames[clientId] || null;
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
            case 'offer':
                await this.handleOffer(client, msg.sdp);
                break;

            case 'ice-candidate':
                await this.handleIceCandidate(client, msg.candidate);
                break;

            case 'ptt_request':
                this.handlePttRequest(client);
                break;

            case 'ptt_release':
                this.handlePttRelease(client);
                break;

            case 'set_display_name':
                if (msg.displayName && msg.displayName !== client.displayName) {
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
        }
    }

    // プッシュ通知subscription登録
    handlePushSubscribe(client, subscription) {
        if (!subscription) return;
        this.pushSubscriptions.set(client.clientId, subscription);
        log(`Push subscription registered: ${client.displayName} (${client.clientId})`);
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
            } else if (client.pc.connectionState === 'disconnected') {
                // WebRTC切断時は即座にWebSocketも閉じる（リソース競合防止）
                log(`${client.displayName}: WebRTC disconnected, closing WebSocket immediately`);
                client.ws.close(1000, 'WebRTC disconnected');
            } else if (client.pc.connectionState === 'failed') {
                // WebRTC接続失敗時はWebSocketも閉じる
                log(`${client.displayName}: WebRTC failed, closing WebSocket`);
                client.ws.close(1000, 'WebRTC connection failed');
            }
        };

        // ICE候補をクライアントに送信
        client.pc.onicecandidate = (candidate) => {
            if (candidate) {
                client.send({
                    type: 'ice-candidate',
                    candidate: {
                        candidate: candidate.candidate,
                        sdpMid: candidate.sdpMid,
                        sdpMLineIndex: candidate.sdpMLineIndex
                    }
                });
            }
        };

        // 受信用トランシーバー
        client.pc.addTransceiver('audio', { direction: 'recvonly' });

        await client.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'offer'));
        const answer = await client.pc.createAnswer();
        await client.pc.setLocalDescription(answer);

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
            } catch (e) {
                // Ignore
            }
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

        // disconnectedタイマークリア
        if (client.disconnectTimer) {
            clearTimeout(client.disconnectTimer);
            client.disconnectTimer = null;
        }

        // PTT解放
        this.pttManager.releaseFloor(client.clientId);

        // WebRTC接続クローズ
        if (client.pc) {
            client.pc.close();
        }

        // P2P接続クリーンアップ
        const p2pConn = this.p2pConnections.get(client.clientId);
        if (p2pConn) {
            if (p2pConn.pc) {
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
            receivedFrameCount: 0
        };
        this.p2pConnections.set(client.clientId, connInfo);

        // 接続状態
        p2pPc.onconnectionstatechange = () => {
            log(`P2P to ${client.displayName}: ${p2pPc.connectionState}`);
            if (p2pPc.connectionState === 'failed' || p2pPc.connectionState === 'closed') {
                this.p2pConnections.delete(client.clientId);
            }
        };

        // ICE候補
        p2pPc.onicecandidate = (candidate) => {
            if (candidate) {
                client.send({
                    type: 'p2p_ice_candidate',
                    from: this.serverClientId,
                    candidate: {
                        candidate: candidate.candidate,
                        sdpMid: candidate.sdpMid,
                        sdpMLineIndex: candidate.sdpMLineIndex
                    }
                });
            }
        };

        // 音声受信（クライアントからの音声）
        p2pPc.ontrack = (event) => {
            log(`P2P received track from ${client.displayName}`);
            const track = event.track;

            track.onReceiveRtp.subscribe((rtp) => {
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

            const timer = setTimeout(() => resolve(), timeout);

            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    resolve();
                }
            };
        });
    }

    // ========== マイク入力（送信）==========

    startMicCapture() {
        if (this.ffmpegProcess) return;

        log(`Starting mic capture: ${MIC_DEVICE}`);

        this.ffmpegProcess = spawn('ffmpeg', [
            // 入力の低遅延設定
            '-fflags', '+nobuffer+flush_packets',
            '-flags', 'low_delay',
            // 入力デバイス
            '-f', 'dshow',
            '-audio_buffer_size', '50',  // 50msバッファ（20msだと音割れ）
            '-i', `audio=${MIC_DEVICE}`,
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

        this.ffmpegProcess.on('error', (err) => {
            logError(`FFmpeg error: ${err.message}`);
            this.ffmpegProcess = null;
        });

        this.ffmpegProcess.on('close', (code) => {
            log(`FFmpeg closed with code ${code}`);
            this.ffmpegProcess = null;
        });

        this.parseOggStream(this.ffmpegProcess.stdout);
    }

    stopMicCapture() {
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill();
            this.ffmpegProcess = null;
            log('Mic capture stopped');
        }
    }

    parseOggStream(stream) {
        let buffer = Buffer.alloc(0);
        let headersParsed = false;

        stream.on('data', (chunk) => {
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
                        this.sendOpusToClients(payload);
                    }
                } else {
                    this.sendOpusToClients(payload);
                }

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

        const rtpBuffer = this.createRtpBuffer(opusData);

        for (const [clientId, connInfo] of this.p2pConnections) {
            if (connInfo.audioTrack && connInfo.pc.connectionState === 'connected') {
                try {
                    connInfo.audioTrack.writeRtp(rtpBuffer);
                } catch (e) {}
            }
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
    }

    const server = new StreamServer();
    server.start();

    // 起動ログ
    log('Server started');

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
