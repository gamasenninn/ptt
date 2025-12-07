// WebRTC Audio Stream Client

let ws = null;
let pc = null;
let audioContext = null;
let analyser = null;
let iceServers = null;  // サーバーから受信したICE設定
let debugVisible = true;
let autoReconnect = true;  // 自動再接続フラグ
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;  // 3秒
let wakeLock = null;  // スクリーンロック防止

function debugLog(msg) {
    console.log(msg);
    const debugEl = document.getElementById('debug');
    if (debugEl) {
        const time = new Date().toLocaleTimeString();
        debugEl.innerHTML += `<div>[${time}] ${msg}</div>`;
        debugEl.scrollTop = debugEl.scrollHeight;
    }
}

function toggleDebug() {
    const debugEl = document.getElementById('debug');
    debugVisible = !debugVisible;
    debugEl.style.display = debugVisible ? 'block' : 'none';
}

// ページ読み込み時にデバッグ領域をクリア
window.addEventListener('DOMContentLoaded', () => {
    const debugEl = document.getElementById('debug');
    if (debugEl) {
        debugEl.innerHTML = '';
    }
});

// Wake Lock取得（スクリーンオフ防止）
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            debugLog('Wake Lock acquired');

            wakeLock.addEventListener('release', () => {
                debugLog('Wake Lock released');
            });
        } catch (err) {
            debugLog('Wake Lock failed: ' + err.message);
        }
    } else {
        debugLog('Wake Lock not supported');
    }
}

// Wake Lock解放
function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
}

// 画面が再表示されたらWake Lockを再取得
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && ws && autoReconnect) {
        await requestWakeLock();
    }
});

function updateStatus(message, state) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = 'status ' + (state || '');
}

function updateButtons(connected) {
    document.getElementById('connectBtn').disabled = connected;
    document.getElementById('disconnectBtn').disabled = !connected;
}

async function connect() {
    // 既に接続中なら何もしない
    if (ws && ws.readyState === WebSocket.OPEN) {
        debugLog('Already connected');
        return;
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) {
        debugLog('Already connecting');
        return;
    }

    autoReconnect = true;  // 接続時は自動再接続を有効化
    updateStatus('接続中...', 'connecting');
    updateButtons(true);

    try {
        // WebSocket接続
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        debugLog('Connecting to ' + wsProtocol + '//' + location.host + '/ws');
        ws = new WebSocket(wsProtocol + '//' + location.host + '/ws');

        ws.onopen = () => {
            debugLog('WebSocket connected, waiting for config...');
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            console.log('Received:', data.type);

            if (data.type === 'config') {
                // サーバーからICE設定を受信
                iceServers = data.iceServers;
                debugLog('ICE servers: ' + JSON.stringify(iceServers.map(s => s.urls)));
                await setupWebRTC();
            } else if (data.type === 'answer') {
                await pc.setRemoteDescription(new RTCSessionDescription({
                    type: 'answer',
                    sdp: data.sdp
                }));
            } else if (data.type === 'ice-candidate' && data.candidate) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } else if (data.type === 'error') {
                updateStatus('エラー: ' + data.message, 'error');
            }
        };

        ws.onerror = (error) => {
            debugLog('WebSocket error');
        };

        ws.onclose = (event) => {
            debugLog('WebSocket closed (code: ' + event.code + ')');
            cleanupConnection();
            scheduleReconnect();
        };

    } catch (error) {
        debugLog('Connection error: ' + error.message);
        updateStatus('接続エラー', 'error');
        cleanupConnection();
        scheduleReconnect();
    }
}

async function setupWebRTC() {
    // RTCPeerConnection作成（サーバーから受信したICE設定を使用）
    pc = new RTCPeerConnection({
        iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // 音声トラック受信時
    pc.ontrack = (event) => {
        debugLog('Track: ' + event.track.kind + ', streams: ' + event.streams.length);
        if (event.streams.length > 0) {
            const audio = document.getElementById('audio');
            audio.srcObject = event.streams[0];
            debugLog('Audio element srcObject set');

            // 音量メーター設定
            setupVolumeMeter(event.streams[0]);
        } else {
            debugLog('ERROR: No streams in track event');
        }
    };

    // ICE候補
    pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: {
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex
                }
            }));
        }
    };

    // 接続状態変化
    pc.onconnectionstatechange = () => {
        debugLog('Connection: ' + pc.connectionState);
        switch (pc.connectionState) {
            case 'connected':
                updateStatus('接続済み - 音声受信中', 'connected');
                updateButtons(true);
                reconnectAttempts = 0;  // 接続成功でリセット
                requestWakeLock();  // スクリーンオフ防止
                break;
            case 'connecting':
                updateStatus('接続中...', 'connecting');
                break;
            case 'disconnected':
                updateStatus('切断されました', 'error');
                cleanupConnection();
                scheduleReconnect();
                break;
            case 'failed':
                updateStatus('接続失敗', 'error');
                cleanupConnection();
                scheduleReconnect();
                break;
        }
    };

    // ICE接続状態の詳細ログ
    pc.oniceconnectionstatechange = () => {
        debugLog('ICE: ' + pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
            debugLog('ERROR: ICE failed - TURN unreachable?');
        }
    };

    // 音声受信用のトランシーバーを追加（受信のみ）
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // Offer作成
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // ICE gathering完了を待つ（relay候補取得後は早めに進む）
    await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
            resolve();
            return;
        }

        let hasRelay = false;
        let hasHostOrSrflx = false;
        let relayTimer = null;

        const timeout = setTimeout(() => {
            debugLog('ICE gathering timeout');
            resolve();
        }, 10000);  // 最大10秒に短縮

        const proceedIfReady = () => {
            // relay候補があれば1秒後に進む（追加の候補を少し待つ）
            if (hasRelay && !relayTimer) {
                relayTimer = setTimeout(() => {
                    debugLog('Proceeding with relay candidate');
                    clearTimeout(timeout);
                    resolve();
                }, 1000);
            }
        };

        pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') {
                clearTimeout(timeout);
                if (relayTimer) clearTimeout(relayTimer);
                resolve();
            }
        });

        // ICE候補ごとにログ出力
        pc.addEventListener('icecandidate', (event) => {
            if (event.candidate) {
                const type = event.candidate.type || 'unknown';
                debugLog('Candidate: ' + type);
                if (type === 'relay') {
                    hasRelay = true;
                    debugLog('✓ TURN relay OK!');
                    proceedIfReady();
                } else if (type === 'host' || type === 'srflx') {
                    hasHostOrSrflx = true;
                }
            } else {
                debugLog('ICE gathering done');
            }
        });
    });

    const hasRelayInSdp = pc.localDescription.sdp.includes('relay');
    debugLog('Sending offer (relay in SDP: ' + hasRelayInSdp + ')');

    // ICE候補を含むSDPを送信
    ws.send(JSON.stringify({
        type: 'offer',
        sdp: pc.localDescription.sdp
    }));
}

function setupVolumeMeter(stream) {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function updateMeter() {
            if (!analyser) return;

            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const percentage = Math.min(100, (average / 128) * 100);

            document.getElementById('volumeBar').style.width = percentage + '%';

            requestAnimationFrame(updateMeter);
        }

        updateMeter();
    } catch (e) {
        console.warn('Volume meter setup failed:', e);
    }
}

function disconnect() {
    autoReconnect = false;  // 手動切断時は自動再接続しない
    reconnectAttempts = 0;
    releaseWakeLock();  // Wake Lock解放
    if (ws) {
        ws.close();
    }
    cleanup();
}

// 接続リソースのみクリーンアップ（自動再接続用）
function cleanupConnection() {
    if (pc) {
        pc.close();
        pc = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
        analyser = null;
    }
    ws = null;
    iceServers = null;

    const audio = document.getElementById('audio');
    if (audio) {
        audio.srcObject = null;
    }
    document.getElementById('volumeBar').style.width = '0%';
}

// 完全クリーンアップ
function cleanup() {
    cleanupConnection();
    updateStatus('未接続', '');
    updateButtons(false);
}

// 自動再接続スケジュール
function scheduleReconnect() {
    if (!autoReconnect) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        debugLog('Max reconnect attempts reached');
        updateStatus('再接続失敗', 'error');
        updateButtons(false);
        return;
    }

    reconnectAttempts++;
    debugLog('Reconnecting in ' + (RECONNECT_DELAY/1000) + 's... (' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ')');
    updateStatus('再接続中... (' + reconnectAttempts + ')', 'connecting');

    setTimeout(() => {
        if (autoReconnect && !ws) {
            connect();
        }
    }, RECONNECT_DELAY);
}

// ページ離脱時にクリーンアップ
window.addEventListener('beforeunload', () => {
    autoReconnect = false;
    cleanup();
});
