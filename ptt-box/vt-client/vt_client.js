/**
 * Virtual Transceiver Client (vt_client.js)
 * Webトランシーバーに接続するバーチャルトランシーバー（Node.js版）
 *
 * 機能:
 * - WebSocket + WebRTC接続
 * - P2P接続（他クライアントとの直接接続）
 * - P2Pで受信した音声をスピーカー出力
 * - PTT状態の受信と表示
 *
 * Usage:
 *   cd ptt-box/vt-client
 *   npm install
 *   npm start
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
} = require('werift');


// 環境変数
const VT_SERVER_URL = process.env.VT_SERVER_URL || 'ws://localhost:9320/ws';

// 定数
const SAMPLE_RATE = 48000;
const CHANNELS = 1;

// グローバル状態
let ws = null;
let pc = null;
let myClientId = null;
let iceServers = [];
let pttState = 'idle';  // idle, transmitting, receiving
let currentSpeaker = null;
let currentSpeakerName = null;
let connected = false;

// P2P接続管理
const p2pConnections = new Map();  // clientId -> { pc, ... }

// FFmpegプロセス（Opusデコード + PCM出力用）
let ffmpegProcess = null;
let audioOutputActive = false;

// FFmpegプロセスを開始（Opus → PCM変換 + スピーカー出力）
function startAudioOutput() {
    if (ffmpegProcess) return;

    // ffmpegでOpusをデコードし、ffplayで再生
    // 入力: Opusパケット（ogg/opus形式でラップ）
    // 出力: スピーカー
    ffmpegProcess = spawn('ffplay', [
        '-f', 'ogg',              // 入力フォーマット: ogg container
        '-i', 'pipe:0',           // 標準入力から
        '-nodisp',                // 表示なし
        '-autoexit',              // 入力終了時に終了
        '-loglevel', 'error'      // エラーのみ表示
    ], {
        stdio: ['pipe', 'ignore', 'pipe']
    });

    ffmpegProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
            log(`FFplay: ${msg}`);
        }
    });

    ffmpegProcess.on('error', (err) => {
        logError(`FFplay error: ${err.message}`);
        ffmpegProcess = null;
        audioOutputActive = false;
    });

    ffmpegProcess.on('close', (code) => {
        log(`FFplay closed with code ${code}`);
        ffmpegProcess = null;
        audioOutputActive = false;
    });

    audioOutputActive = true;
    log('Audio output started (FFplay)');
}

// OggS pageを作成してOpusパケットをラップ
// シンプルな方法: 生のOpusパケットをOggコンテナに入れる
let oggPageSequence = 0;
let oggGranulePos = 0;
const OGG_SERIAL = 0x12345678;

function createOggPage(payload, headerType = 0, granulePos = 0) {
    // OggSヘッダー (27 bytes + segment table + payload)
    const segmentCount = Math.ceil(payload.length / 255);
    const segmentTable = [];
    let remaining = payload.length;
    for (let i = 0; i < segmentCount; i++) {
        const size = Math.min(remaining, 255);
        segmentTable.push(size);
        remaining -= size;
    }
    if (remaining === 0 && payload.length > 0 && payload.length % 255 === 0) {
        segmentTable.push(0);  // Terminating zero
    }

    const headerSize = 27 + segmentTable.length;
    const page = Buffer.alloc(headerSize + payload.length);

    // Magic: OggS
    page.write('OggS', 0);
    // Version
    page.writeUInt8(0, 4);
    // Header type
    page.writeUInt8(headerType, 5);
    // Granule position (64-bit)
    page.writeBigUInt64LE(BigInt(granulePos), 6);
    // Serial number
    page.writeUInt32LE(OGG_SERIAL, 14);
    // Page sequence
    page.writeUInt32LE(oggPageSequence++, 18);
    // CRC (placeholder, will calculate)
    page.writeUInt32LE(0, 22);
    // Number of segments
    page.writeUInt8(segmentTable.length, 26);
    // Segment table
    for (let i = 0; i < segmentTable.length; i++) {
        page.writeUInt8(segmentTable[i], 27 + i);
    }
    // Payload
    payload.copy(page, headerSize);

    // Calculate CRC32
    const crc = crc32Ogg(page);
    page.writeUInt32LE(crc, 22);

    return page;
}

// OGG CRC32 lookup table
const crcTable = (() => {
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

function crc32Ogg(data) {
    let crc = 0;
    for (let i = 0; i < data.length; i++) {
        crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ data[i]) & 0xFF]) >>> 0;
    }
    return crc;
}

// Opus ID Headerを作成
// OUTPUT_GAIN: dB単位のゲイン（256 = 1dB）
const OUTPUT_GAIN_DB = 6;  // 6dB boost（約2倍の音量）

function createOpusIdHeader() {
    const header = Buffer.alloc(19);
    header.write('OpusHead', 0);        // Magic
    header.writeUInt8(1, 8);            // Version
    header.writeUInt8(CHANNELS, 9);     // Channel count
    header.writeUInt16LE(0, 10);        // Pre-skip
    header.writeUInt32LE(SAMPLE_RATE, 12);  // Input sample rate
    header.writeInt16LE(OUTPUT_GAIN_DB * 256, 16);  // Output gain (Q7.8 format)
    header.writeUInt8(0, 18);           // Channel mapping
    return header;
}

// Opus Comment Headerを作成
function createOpusCommentHeader() {
    const vendor = 'vt_client';
    const header = Buffer.alloc(8 + 4 + vendor.length + 4);
    header.write('OpusTags', 0);
    header.writeUInt32LE(vendor.length, 8);
    header.write(vendor, 12);
    header.writeUInt32LE(0, 12 + vendor.length);  // No comments
    return header;
}

let oggInitialized = false;

// Opusパケットを音声出力に送信
function sendOpusToOutput(opusPayload) {
    if (!ffmpegProcess || !ffmpegProcess.stdin.writable) {
        return;
    }

    try {
        // 最初のパケットの前にOggヘッダーを送信
        if (!oggInitialized) {
            // ID Header page (BOS)
            const idHeader = createOpusIdHeader();
            const idPage = createOggPage(idHeader, 0x02, 0);  // BOS flag
            ffmpegProcess.stdin.write(idPage);

            // Comment Header page
            const commentHeader = createOpusCommentHeader();
            const commentPage = createOggPage(commentHeader, 0, 0);
            ffmpegProcess.stdin.write(commentPage);

            oggInitialized = true;
            log('Ogg/Opus headers sent');
        }

        // Opusパケットをページとして送信
        oggGranulePos += 960;  // 20ms @ 48kHz
        const dataPage = createOggPage(opusPayload, 0, oggGranulePos);
        ffmpegProcess.stdin.write(dataPage);
    } catch (e) {
        // Write error, ignore
    }
}

// 音声出力を停止
function stopAudioOutput() {
    if (ffmpegProcess) {
        try {
            ffmpegProcess.stdin.end();
            ffmpegProcess.kill();
        } catch (e) {
            // Ignore
        }
        ffmpegProcess = null;
    }
    oggInitialized = false;
    oggPageSequence = 0;
    oggGranulePos = 0;
    audioOutputActive = false;
}

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

// WebSocket接続
async function connect() {
    log(`Connecting to ${VT_SERVER_URL}`);

    return new Promise((resolve, reject) => {
        ws = new WebSocket(VT_SERVER_URL);

        ws.on('open', () => {
            log('WebSocket connected');
        });

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                await handleMessage(msg);

                // config受信後に接続完了
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
            connected = false;
            cleanup();
        });
    });
}

// メッセージハンドラ
async function handleMessage(msg) {
    switch (msg.type) {
        case 'config':
            myClientId = msg.clientId;
            iceServers = msg.iceServers || [];
            log(`Received config: clientId=${myClientId}`);
            log(`ICE servers: ${iceServers.map(s => s.urls).join(', ')}`);

            // WebRTC接続を開始
            await setupWebRTC();
            break;

        case 'answer':
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp, 'answer'));
                log('Answer received and set');
                connected = true;
            }
            break;

        case 'ice-candidate':
            if (pc && msg.candidate) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                } catch (e) {
                    // Ignore ICE candidate errors
                }
            }
            break;

        case 'ptt_status':
            handlePttStatus(msg);
            break;

        case 'ptt_granted':
            log('PTT granted');
            pttState = 'transmitting';
            break;

        case 'ptt_denied':
            log(`PTT denied: ${msg.speakerName} is speaking`);
            break;

        // P2Pシグナリング
        case 'client_list':
            await handleClientList(msg.clients);
            break;

        case 'client_joined':
            log(`Client joined: ${msg.displayName || msg.clientId}`);
            // 新規参加者からのOfferを待つ
            break;

        case 'client_left':
            log(`Client left: ${msg.clientId}`);
            await closeP2PConnection(msg.clientId);
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

// PTT状態ハンドラ
function handlePttStatus(msg) {
    const state = msg.state || 'idle';
    const speaker = msg.speaker;
    const speakerName = msg.speakerName;

    const oldState = pttState;

    if (speaker === myClientId) {
        pttState = 'transmitting';
    } else if (state === 'transmitting') {
        pttState = 'receiving';
    } else {
        pttState = 'idle';
    }

    currentSpeaker = speaker;
    currentSpeakerName = speakerName;

    // 状態変化時の処理
    if (oldState !== pttState) {
        log(`PTT state: ${pttState} (speaker: ${speakerName || 'none'})`);

        // receiving開始時: 音声出力を開始
        if (pttState === 'receiving') {
            startAudioOutput();
        }
        // idle/transmitting: 音声出力を停止
        else if (oldState === 'receiving') {
            stopAudioOutput();
        }
    }
}

// WebRTC接続セットアップ
async function setupWebRTC() {
    log('Setting up WebRTC...');

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

    pc = new RTCPeerConnection(config);

    // 接続状態変更
    pc.onconnectionstatechange = () => {
        log(`Connection state: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
            connected = true;
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            connected = false;
        }
    };

    // 音声トラック受信（サーバーからの音声）
    pc.ontrack = (event) => {
        log(`Received track: kind=${event.track.kind}`);
        // サーバーからのトラックは今は使用しない（P2Pで受信するため）
    };

    // 音声トランシーバー追加（受信のみ）
    const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });

    // Offer作成
    const offer = await pc.createOffer();
    const monoSdp = forceOpusMono(offer.sdp);
    await pc.setLocalDescription(new RTCSessionDescription(monoSdp, 'offer'));

    // ICE gathering完了を待つ
    log('Waiting for ICE gathering...');
    await waitForIceGathering(pc);

    // Offer送信
    ws.send(JSON.stringify({
        type: 'offer',
        sdp: pc.localDescription.sdp
    }));
    log('Offer sent');
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

// ========== P2P接続管理 ==========

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
        frameCount: 0
    };
    p2pConnections.set(remoteClientId, connInfo);

    // 接続状態変更
    p2pPc.onconnectionstatechange = () => {
        log(`P2P ${remoteClientId}: connection state = ${p2pPc.connectionState}`);
        if (p2pPc.connectionState === 'failed' || p2pPc.connectionState === 'closed') {
            closeP2PConnection(remoteClientId);
        }
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

    // 音声トラック受信
    p2pPc.ontrack = (event) => {
        log(`P2P ${remoteClientId}: received track kind=${event.track.kind}`);

        const track = event.track;

        // RTPパケット受信時の処理
        track.onReceiveRtp.subscribe((rtp) => {
            // PTTがreceiving状態の時のみ音声出力
            if (pttState !== 'receiving') {
                return;
            }

            // 発話者からの音声のみ出力
            if (remoteClientId !== currentSpeaker) {
                return;
            }

            connInfo.frameCount++;

            // 最初の5フレームと100フレームごとにログ
            if (connInfo.frameCount <= 5 || connInfo.frameCount % 100 === 0) {
                log(`P2P ${remoteClientId}: frame ${connInfo.frameCount}, payload=${rtp.payload.length} bytes`);
            }

            // OpusパケットをFFplayに送信
            sendOpusToOutput(rtp.payload);
        });
    };

    // 受信用トランシーバー追加
    p2pPc.addTransceiver('audio', { direction: 'recvonly' });

    return connInfo;
}

async function initiateP2POffer(remoteClientId) {
    const connInfo = await createP2PConnection(remoteClientId, true);

    // Offer作成
    const offer = await connInfo.pc.createOffer();
    const monoSdp = forceOpusMono(offer.sdp);
    await connInfo.pc.setLocalDescription(new RTCSessionDescription(monoSdp, 'offer'));

    // ICE gathering完了待機
    await waitForIceGathering(connInfo.pc);

    // Offer送信
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

    // Remote description設定
    await connInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'offer'));
    connInfo.remoteDescriptionSet = true;

    // 保留中のICE候補を処理
    for (const candidate of connInfo.pendingCandidates) {
        try {
            await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            // Ignore
        }
    }
    connInfo.pendingCandidates = [];

    // Answer作成
    const answer = await connInfo.pc.createAnswer();
    const monoSdp = forceOpusMono(answer.sdp);
    await connInfo.pc.setLocalDescription(new RTCSessionDescription(monoSdp, 'answer'));

    // ICE gathering完了待機
    await waitForIceGathering(connInfo.pc);

    // Answer送信
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
    if (!connInfo) {
        return;
    }

    await connInfo.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'answer'));
    connInfo.remoteDescriptionSet = true;

    // 保留中のICE候補を処理
    for (const candidate of connInfo.pendingCandidates) {
        try {
            await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            // Ignore
        }
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
        } catch (e) {
            // Ignore
        }
    } else {
        connInfo.pendingCandidates.push(candidate);
    }
}

async function closeP2PConnection(remoteClientId) {
    const connInfo = p2pConnections.get(remoteClientId);
    if (connInfo) {
        if (connInfo.pc) {
            await connInfo.pc.close();
        }
        p2pConnections.delete(remoteClientId);
        log(`P2P connection closed: ${remoteClientId}`);
    }
}

// クリーンアップ
function cleanup() {
    // 音声出力を停止
    stopAudioOutput();

    // P2P接続をクローズ
    for (const [clientId] of p2pConnections) {
        closeP2PConnection(clientId);
    }

    if (pc) {
        pc.close();
        pc = null;
    }
}

// メイン
async function main() {
    console.log('='.repeat(50));
    console.log('  Virtual Transceiver (Node.js)');
    console.log('='.repeat(50));
    console.log(`  Server: ${VT_SERVER_URL}`);
    console.log('='.repeat(50));

    try {
        await connect();
        log('Virtual Transceiver connected');

        // プロセス終了時のクリーンアップ
        process.on('SIGINT', () => {
            log('Shutting down...');
            cleanup();
            process.exit(0);
        });

    } catch (e) {
        logError(`Failed to connect: ${e.message}`);
        process.exit(1);
    }
}

main();
