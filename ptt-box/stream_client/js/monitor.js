// PTT Monitor Client

let ws = null;
let pc = null;
let iceServers = null;
let monitorId = null;
let debugVisible = false;
let autoReconnect = true;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;

function debugLog(msg) {
    console.log(msg);
    const debugEl = document.getElementById('debug');
    if (debugEl) {
        const time = new Date().toLocaleTimeString();
        debugEl.innerHTML += `<div>[${time}] ${msg}</div>`;
        debugEl.scrollTop = debugEl.scrollHeight;
        // 最大100行保持
        const lines = debugEl.querySelectorAll('div');
        if (lines.length > 100) {
            lines[0].remove();
        }
    }
}

function toggleDebug() {
    const debugEl = document.getElementById('debug');
    debugVisible = !debugVisible;
    debugEl.style.display = debugVisible ? 'block' : 'none';
}

// 接続状態の更新
function updateConnectionStatus(status) {
    const badge = document.getElementById('connectionStatus');
    badge.className = 'status-badge ' + status;
    switch (status) {
        case 'connected':
            badge.textContent = '接続済み';
            break;
        case 'connecting':
            badge.textContent = '接続中...';
            break;
        case 'disconnected':
            badge.textContent = '未接続';
            break;
    }
}

// 時間フォーマット（秒 → MM:SS or HH:MM:SS）
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

// 相対時間フォーマット
function formatRelativeTime(seconds) {
    if (seconds < 60) {
        return `${Math.floor(seconds)}秒前`;
    } else if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}分前`;
    } else {
        return `${Math.floor(seconds / 3600)}時間前`;
    }
}

// モニター状態の更新
function updateMonitorState(state) {
    // PTT状態更新
    const pttIndicator = document.getElementById('pttIndicator');
    const pttSpeaker = document.getElementById('pttSpeaker');
    const pttTimer = document.getElementById('pttTimer');
    const pttProgressBar = document.getElementById('pttProgressBar');

    if (state.ptt.state === 'transmitting') {
        pttIndicator.className = 'ptt-indicator transmitting';
        pttSpeaker.textContent = `送信中: ${state.ptt.speakerName || state.ptt.speaker}`;
        pttTimer.textContent = `${state.ptt.elapsed.toFixed(1)}s / ${state.ptt.maxTime}s`;
        const progress = (state.ptt.elapsed / state.ptt.maxTime) * 100;
        pttProgressBar.style.width = `${Math.min(progress, 100)}%`;
    } else {
        pttIndicator.className = 'ptt-indicator idle';
        pttSpeaker.textContent = '待機中';
        pttTimer.textContent = '';
        pttProgressBar.style.width = '0%';
    }

    // 統計更新
    document.getElementById('statClients').textContent = state.stats.totalClients;
    document.getElementById('statMonitors').textContent = state.stats.totalMonitors;
    document.getElementById('statUptime').textContent = formatDuration(state.stats.uptime);

    // クライアントリスト更新
    updateClientList(state.clients);
}

// クライアントリスト更新
function updateClientList(clients) {
    const container = document.getElementById('clientList');
    const countEl = document.getElementById('clientCount');

    countEl.textContent = clients.length;

    if (clients.length === 0) {
        container.innerHTML = '<div class="no-clients">接続中のクライアントはありません</div>';
        return;
    }

    let html = '';
    for (const client of clients) {
        const statusClass = client.connectionState === 'connected' ? 'connected' :
                           client.connectionState === 'connecting' ? 'connecting' : 'failed';
        const iceClass = client.iceState === 'connected' ? 'connected' :
                        client.iceState === 'checking' ? 'checking' : 'failed';
        const iceLabel = client.iceState === 'connected' ? '✓' :
                        client.iceState === 'checking' ? '⏳' : '✗';

        html += `
            <div class="client-item">
                <div class="client-status-dot ${statusClass}"></div>
                <div class="client-info">
                    <div class="client-name">${escapeHtml(client.displayName)}</div>
                    <div class="client-details">ID: ${client.clientId} | 接続: ${formatRelativeTime(client.duration)}</div>
                </div>
                <span class="client-ice ${iceClass}">ICE: ${iceLabel}</span>
            </div>
        `;
    }
    container.innerHTML = html;
}

// HTMLエスケープ
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// WebSocket接続
async function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        return;
    }

    autoReconnect = true;
    updateConnectionStatus('connecting');

    try {
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        debugLog('Connecting to ' + wsProtocol + '//' + location.host + '/ws/monitor');
        ws = new WebSocket(wsProtocol + '//' + location.host + '/ws/monitor');

        ws.onopen = () => {
            debugLog('WebSocket connected');
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'config') {
                iceServers = data.iceServers;
                monitorId = data.monitorId;
                debugLog('Monitor ID: ' + monitorId);
                await setupWebRTC();
            } else if (data.type === 'monitor_state') {
                updateMonitorState(data);
            } else if (data.type === 'answer') {
                await pc.setRemoteDescription(new RTCSessionDescription({
                    type: 'answer',
                    sdp: data.sdp
                }));
                debugLog('WebRTC answer received');
            } else if (data.type === 'ice-candidate' && data.candidate) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        };

        ws.onerror = () => {
            debugLog('WebSocket error');
        };

        ws.onclose = () => {
            debugLog('WebSocket closed');
            cleanup();
            scheduleReconnect();
        };

    } catch (error) {
        debugLog('Connection error: ' + error.message);
        updateConnectionStatus('disconnected');
        cleanup();
        scheduleReconnect();
    }
}

// WebRTC設定（音声受信のみ）
async function setupWebRTC() {
    pc = new RTCPeerConnection({
        iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // 音声受信専用
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // 音声トラック受信時
    pc.ontrack = (event) => {
        debugLog('Audio track received');
        if (event.streams.length > 0) {
            const audio = document.getElementById('audio');
            audio.srcObject = event.streams[0];
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
        if (pc.connectionState === 'connected') {
            updateConnectionStatus('connected');
            reconnectAttempts = 0;
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            updateConnectionStatus('disconnected');
            cleanup();
            scheduleReconnect();
        }
    };

    // Offer作成
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // ICE gathering完了を待つ
    await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
            resolve();
            return;
        }
        const timeout = setTimeout(resolve, 10000);
        pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') {
                clearTimeout(timeout);
                resolve();
            }
        });
    });

    debugLog('Sending offer');
    ws.send(JSON.stringify({
        type: 'offer',
        sdp: pc.localDescription.sdp
    }));
}

// クリーンアップ
function cleanup() {
    if (pc) {
        pc.close();
        pc = null;
    }
    ws = null;
    iceServers = null;
    updateConnectionStatus('disconnected');
}

// 自動再接続
function scheduleReconnect() {
    if (!autoReconnect) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        debugLog('Max reconnect attempts reached');
        return;
    }

    reconnectAttempts++;
    debugLog(`Reconnecting in ${RECONNECT_DELAY / 1000}s... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    setTimeout(() => {
        if (autoReconnect && !ws) {
            connect();
        }
    }, RECONNECT_DELAY);
}

// ボリューム調整
function setVolume(value) {
    const audio = document.getElementById('audio');
    const volumeValue = document.getElementById('volumeValue');

    if (audio) {
        audio.volume = value / 100;
    }
    if (volumeValue) {
        volumeValue.textContent = value + '%';
    }
}

// ページ読み込み時に自動接続
window.addEventListener('DOMContentLoaded', () => {
    const debugEl = document.getElementById('debug');
    if (debugEl) {
        debugEl.innerHTML = '';
    }
    connect();
});

// ページ離脱時にクリーンアップ
window.addEventListener('beforeunload', () => {
    autoReconnect = false;
    cleanup();
});
