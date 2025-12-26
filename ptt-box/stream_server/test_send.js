/**
 * werift送信テスト
 *
 * 目的: weriftでOpus音声をP2P送信できるか確認
 *
 * テスト方法:
 * 1. Python版stream_server.pyを起動
 * 2. ブラウザでWebトランシーバーに接続
 * 3. このスクリプトを実行
 * 4. ブラウザで音声が受信できるか確認
 */

require('dotenv').config();
const WebSocket = require('ws');
const { spawn } = require('child_process');
const {
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    useAbsSendTime,
    useSdesMid,
    MediaStreamTrack,
} = require('werift');

// 環境変数
const SERVER_URL = process.env.VT_SERVER_URL || 'ws://localhost:9320/ws';

// 定数
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960

// グローバル状態
let ws = null;
let myClientId = null;
let iceServers = [];
let ffmpegProcess = null;
let serverPc = null;  // サーバーとのWebRTC接続

// P2P接続管理
const p2pConnections = new Map();

// 音声トラック
let audioTrack = null;

function log(msg) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${msg}`);
}

function logError(msg) {
    const time = new Date().toLocaleTimeString();
    console.error(`[${time}] ERROR: ${msg}`);
}

// SDPをOpusモノラルに強制
function forceOpusMono(sdp) {
    const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
    if (!opusMatch) {
        return sdp;
    }
    const opusPayloadType = opusMatch[1];

    const fmtpRegex = new RegExp(`a=fmtp:${opusPayloadType} (.+)`);
    if (fmtpRegex.test(sdp)) {
        sdp = sdp.replace(fmtpRegex, `a=fmtp:${opusPayloadType} $1;stereo=0;sprop-stereo=0`);
    } else {
        sdp = sdp.replace(
            new RegExp(`(a=rtpmap:${opusPayloadType} opus/48000/2)`),
            `$1\r\na=fmtp:${opusPayloadType} stereo=0;sprop-stereo=0`
        );
    }
    return sdp;
}

// FFmpegでマイク入力をキャプチャ → Opusエンコード
function startMicCapture() {
    // Windows: dshow形式でマイクをキャプチャ
    // 出力: Opus in OGG container → stdout
    const micDevice = process.env.MIC_DEVICE || 'CABLE Output (VB-Audio Virtual Cable)';
    log(`Using microphone: ${micDevice}`);

    ffmpegProcess = spawn('ffmpeg', [
        '-f', 'dshow',
        '-i', `audio=${micDevice}`,  // デバイス名は環境変数で設定
        '-ac', String(CHANNELS),
        '-ar', String(SAMPLE_RATE),
        '-c:a', 'libopus',
        '-b:a', '24k',
        '-frame_duration', String(FRAME_DURATION_MS),
        '-application', 'voip',
        '-vbr', 'off',
        '-page_duration', '20000',  // 20ms per OGG page
        '-flush_packets', '1',
        '-f', 'ogg',
        'pipe:1'
    ], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    ffmpegProcess.stderr.on('data', (data) => {
        // FFmpegのログ（デバッグ用）
        // log(`FFmpeg: ${data.toString()}`);
    });

    ffmpegProcess.on('error', (err) => {
        logError(`FFmpeg error: ${err.message}`);
    });

    ffmpegProcess.on('close', (code) => {
        log(`FFmpeg closed with code ${code}`);
        ffmpegProcess = null;
    });

    log('Microphone capture started');

    // OGGストリームからOpusパケットを抽出
    parseOggStream(ffmpegProcess.stdout);
}

// OGGストリームをパースしてOpusパケットを抽出
let packetCount = 0;

function parseOggStream(stream) {
    let buffer = Buffer.alloc(0);
    let headersParsed = false;

    stream.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        // OGGページを探す
        while (buffer.length >= 27) {
            // OggSマジックを探す
            if (buffer.toString('ascii', 0, 4) !== 'OggS') {
                // マジックが見つからない場合、1バイトスキップ
                buffer = buffer.slice(1);
                continue;
            }

            // ヘッダー解析
            const headerType = buffer.readUInt8(5);
            const numSegments = buffer.readUInt8(26);

            if (buffer.length < 27 + numSegments) {
                break; // セグメントテーブルが不完全
            }

            // セグメントサイズを計算
            let payloadSize = 0;
            for (let i = 0; i < numSegments; i++) {
                payloadSize += buffer.readUInt8(27 + i);
            }

            const pageSize = 27 + numSegments + payloadSize;
            if (buffer.length < pageSize) {
                break; // ページが不完全
            }

            // ペイロードを抽出
            const payload = buffer.slice(27 + numSegments, pageSize);

            // 最初の2ページはOpusHead/OpusTagsヘッダー
            if (!headersParsed) {
                if (payload.toString('ascii', 0, 8) === 'OpusHead' ||
                    payload.toString('ascii', 0, 8) === 'OpusTags') {
                    log(`Skipping Opus header: ${payload.toString('ascii', 0, 8)}`);
                } else {
                    headersParsed = true;
                    packetCount++;
                    if (packetCount <= 5) {
                        log(`Opus packet #${packetCount}: ${payload.length} bytes`);
                    }
                    sendOpusPacket(payload);
                }
            } else {
                // 音声パケット
                packetCount++;
                if (packetCount <= 5 || packetCount % 50 === 0) {
                    log(`Opus packet #${packetCount}: ${payload.length} bytes`);
                }
                sendOpusPacket(payload);
            }

            // 次のページへ
            buffer = buffer.slice(pageSize);
        }
    });

    stream.on('error', (err) => {
        logError(`Stream error: ${err.message}`);
    });

    stream.on('end', () => {
        log('Stream ended');
    });
}

// RTP送信用の状態
let sendCount = 0;
let rtpSequence = 0;
let rtpTimestamp = 0;
const OPUS_PAYLOAD_TYPE = 111;  // 一般的なOpusのペイロードタイプ
const SSRC = Math.floor(Math.random() * 0xFFFFFFFF);

// RTPパケットをBufferとして構築
function createRtpBuffer(payload) {
    const seq = rtpSequence++ & 0xFFFF;
    const ts = rtpTimestamp >>> 0;  // 32bit unsigned

    // RTPヘッダー (12 bytes) + payload
    const header = Buffer.alloc(12);

    // Version=2, Padding=0, Extension=0, CSRC count=0
    header.writeUInt8(0x80, 0);
    // Marker=0, Payload Type
    header.writeUInt8(OPUS_PAYLOAD_TYPE, 1);
    // Sequence Number (big endian)
    header.writeUInt16BE(seq, 2);
    // Timestamp (big endian)
    header.writeUInt32BE(ts, 4);
    // SSRC (big endian)
    header.writeUInt32BE(SSRC, 8);

    // タイムスタンプを進める（20ms = 960サンプル @ 48kHz）
    rtpTimestamp += 960;

    return Buffer.concat([header, payload]);
}

// Opusパケットを全P2P接続に送信
function sendOpusPacket(opusData) {
    if (opusData.length === 0) return;

    // RTPパケットをBufferとして構築
    const rtpBuffer = createRtpBuffer(opusData);

    for (const [clientId, connInfo] of p2pConnections) {
        if (connInfo.audioTrack) {
            try {
                // weriftのMediaStreamTrackにRTPパケット(Buffer)を送信
                connInfo.audioTrack.writeRtp(rtpBuffer);
                sendCount++;
                if (sendCount <= 5 || sendCount % 50 === 0) {
                    log(`Sent packet #${sendCount} to ${clientId} (len=${opusData.length})`);
                }
            } catch (e) {
                logError(`Send error to ${clientId}: ${e.message}`);
            }
        } else {
            if (sendCount === 0) {
                log(`No audioTrack for ${clientId}`);
            }
        }
    }

    if (p2pConnections.size === 0 && packetCount <= 5) {
        log(`No P2P connections yet, packet dropped`);
    }
}

// サーバーとのWebRTC接続（client_listを受信するために必要）
async function setupServerConnection() {
    log('Setting up server WebRTC connection...');

    const config = {
        iceServers: iceServers.map(s => ({
            urls: s.urls,
            username: s.username,
            credential: s.credential
        })),
        headerExtensions: {
            audio: [useSdesMid(), useAbsSendTime()]
        }
    };

    serverPc = new RTCPeerConnection(config);

    serverPc.onconnectionstatechange = () => {
        log(`Server connection state: ${serverPc.connectionState}`);
    };

    // 受信用トランシーバー（サーバーからは音声を受信しないがプロトコル上必要）
    serverPc.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await serverPc.createOffer();
    const monoSdp = forceOpusMono(offer.sdp);
    await serverPc.setLocalDescription(new RTCSessionDescription(monoSdp, 'offer'));

    await waitForIceGathering(serverPc);

    ws.send(JSON.stringify({
        type: 'offer',
        sdp: serverPc.localDescription.sdp
    }));
    log('Server offer sent');
}

// WebSocket接続
async function connect() {
    log(`Connecting to ${SERVER_URL}`);

    return new Promise((resolve, reject) => {
        ws = new WebSocket(SERVER_URL);

        ws.on('open', () => {
            log('WebSocket connected');
        });

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                await handleMessage(msg);

                if (msg.type === 'config') {
                    resolve();
                }
            } catch (e) {
                logError(`Message parse error: ${e.message}`);
            }
        });

        ws.on('error', (err) => {
            logError(`WebSocket error: ${err.message}`);
            reject(err);
        });

        ws.on('close', () => {
            log('WebSocket closed');
            cleanup();
        });
    });
}

// メッセージハンドラ
async function handleMessage(msg) {
    // 全メッセージをログ（デバッグ用）
    if (!['ptt_status'].includes(msg.type)) {
        log(`Message: ${msg.type}`);
    }

    switch (msg.type) {
        case 'config':
            myClientId = msg.clientId;
            iceServers = msg.iceServers || [];
            log(`Received config: clientId=${myClientId}`);
            // サーバーとのWebRTC接続を開始（client_listを受信するために必要）
            await setupServerConnection();
            break;

        case 'answer':
            if (serverPc) {
                await serverPc.setRemoteDescription(new RTCSessionDescription(msg.sdp, 'answer'));
                log('Server answer received');
            }
            break;

        case 'ice-candidate':
            if (serverPc && msg.candidate) {
                try {
                    await serverPc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                } catch (e) {}
            }
            break;

        case 'ptt_status':
            log(`PTT status: ${msg.state} (speaker: ${msg.speakerName || 'none'})`);
            break;

        case 'client_list':
            log(`Client list received: ${msg.clients.length} clients`);
            for (const c of msg.clients) {
                log(`  - ${c.clientId} (${c.displayName || 'no name'})`);
            }
            await handleClientList(msg.clients);
            break;

        case 'client_joined':
            log(`Client joined: ${msg.displayName || msg.clientId}`);
            // 新しいクライアントにP2P接続を開始
            if (!p2pConnections.has(msg.clientId)) {
                await initiateP2POffer(msg.clientId);
            }
            break;

        case 'client_left':
            log(`Client left: ${msg.clientId}`);
            closeP2PConnection(msg.clientId);
            break;

        case 'p2p_offer':
            await handleP2POffer(msg.from, msg.sdp);
            break;

        case 'p2p_answer':
            await handleP2PAnswer(msg.from, msg.sdp);
            break;

        case 'p2p_ice_candidate':
            await handleP2PIceCandidate(msg.from, msg.candidate);
            break;
    }
}

// ICE gathering完了待機
function waitForIceGathering(peerConnection, timeout = 5000) {
    return new Promise((resolve) => {
        if (peerConnection.iceGatheringState === 'complete') {
            resolve();
            return;
        }

        const timer = setTimeout(() => {
            log('ICE gathering timeout');
            resolve();
        }, timeout);

        peerConnection.onicegatheringstatechange = () => {
            if (peerConnection.iceGatheringState === 'complete') {
                clearTimeout(timer);
                resolve();
            }
        };
    });
}

// P2P接続管理
async function handleClientList(clients) {
    log(`Client list: ${clients.length} clients`);

    for (const client of clients) {
        if (!p2pConnections.has(client.clientId)) {
            await initiateP2POffer(client.clientId);
        }
    }
}

async function createP2PConnection(remoteClientId, isOfferer) {
    log(`Creating P2P connection to ${remoteClientId} (offerer=${isOfferer})`);

    const config = {
        iceServers: iceServers.map(s => ({
            urls: s.urls,
            username: s.username,
            credential: s.credential
        })),
        headerExtensions: {
            audio: [useSdesMid(), useAbsSendTime()]
        }
    };

    const p2pPc = new RTCPeerConnection(config);

    const connInfo = {
        pc: p2pPc,
        pendingCandidates: [],
        remoteDescriptionSet: false,
        audioTrack: null
    };
    p2pConnections.set(remoteClientId, connInfo);

    // 接続状態変更
    p2pPc.onconnectionstatechange = () => {
        log(`P2P ${remoteClientId}: connection state = ${p2pPc.connectionState}`);
    };

    // ICE候補送信
    p2pPc.onicecandidate = (candidate) => {
        if (candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'p2p_ice_candidate',
                to: remoteClientId,
                candidate: {
                    candidate: candidate.candidate,
                    sdpMid: candidate.sdpMid,
                    sdpMLineIndex: candidate.sdpMLineIndex
                }
            }));
        }
    };

    // 送信用トランシーバー追加（sendonly）
    // weriftでMediaStreamTrackを作成して送信
    const track = new MediaStreamTrack({ kind: 'audio' });
    connInfo.audioTrack = track;
    p2pPc.addTrack(track);

    return connInfo;
}

async function initiateP2POffer(remoteClientId) {
    const connInfo = await createP2PConnection(remoteClientId, true);

    const offer = await connInfo.pc.createOffer();
    const monoSdp = forceOpusMono(offer.sdp);
    await connInfo.pc.setLocalDescription(new RTCSessionDescription(monoSdp, 'offer'));

    await waitForIceGathering(connInfo.pc);

    ws.send(JSON.stringify({
        type: 'p2p_offer',
        to: remoteClientId,
        sdp: connInfo.pc.localDescription.sdp
    }));
    log(`P2P offer sent to ${remoteClientId}`);
}

async function handleP2POffer(fromClientId, sdp) {
    log(`P2P offer from ${fromClientId}`);

    let connInfo = p2pConnections.get(fromClientId);
    if (!connInfo) {
        connInfo = await createP2PConnection(fromClientId, false);
    }

    await connInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'offer'));
    connInfo.remoteDescriptionSet = true;

    for (const candidate of connInfo.pendingCandidates) {
        try {
            await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {}
    }
    connInfo.pendingCandidates = [];

    const answer = await connInfo.pc.createAnswer();
    const monoSdp = forceOpusMono(answer.sdp);
    await connInfo.pc.setLocalDescription(new RTCSessionDescription(monoSdp, 'answer'));

    await waitForIceGathering(connInfo.pc);

    ws.send(JSON.stringify({
        type: 'p2p_answer',
        to: fromClientId,
        sdp: connInfo.pc.localDescription.sdp
    }));
    log(`P2P answer sent to ${fromClientId}`);
}

async function handleP2PAnswer(fromClientId, sdp) {
    log(`P2P answer from ${fromClientId}`);

    const connInfo = p2pConnections.get(fromClientId);
    if (!connInfo) return;

    await connInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'answer'));
    connInfo.remoteDescriptionSet = true;

    for (const candidate of connInfo.pendingCandidates) {
        try {
            await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {}
    }
    connInfo.pendingCandidates = [];

    log(`P2P connection established with ${fromClientId}`);
}

async function handleP2PIceCandidate(fromClientId, candidateData) {
    if (!candidateData) return;

    let connInfo = p2pConnections.get(fromClientId);
    if (!connInfo) {
        connInfo = await createP2PConnection(fromClientId, false);
    }

    const candidate = {
        candidate: candidateData.candidate,
        sdpMid: candidateData.sdpMid,
        sdpMLineIndex: candidateData.sdpMLineIndex
    };

    if (connInfo.remoteDescriptionSet) {
        try {
            await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {}
    } else {
        connInfo.pendingCandidates.push(candidate);
    }
}

function closeP2PConnection(remoteClientId) {
    const connInfo = p2pConnections.get(remoteClientId);
    if (connInfo) {
        if (connInfo.pc) {
            connInfo.pc.close();
        }
        p2pConnections.delete(remoteClientId);
        log(`P2P connection closed: ${remoteClientId}`);
    }
}

function cleanup() {
    if (ffmpegProcess) {
        ffmpegProcess.kill();
        ffmpegProcess = null;
    }

    for (const [clientId] of p2pConnections) {
        closeP2PConnection(clientId);
    }
}

// PTTリクエスト
function requestPTT() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ptt_request' }));
        log('PTT requested');
    }
}

// メイン
async function main() {
    console.log('='.repeat(50));
    console.log('  werift Send Test');
    console.log('='.repeat(50));
    console.log(`  Server: ${SERVER_URL}`);
    console.log('='.repeat(50));

    try {
        await connect();
        log('Connected to server');

        // 3秒後にPTTリクエスト＆マイクキャプチャ開始
        log('Starting in 3 seconds...');
        setTimeout(() => {
            requestPTT();
            startMicCapture();
        }, 3000);

        process.on('SIGINT', () => {
            log('Shutting down...');
            cleanup();
            process.exit(0);
        });

    } catch (e) {
        logError(`Failed: ${e.message}`);
        process.exit(1);
    }
}

main();
