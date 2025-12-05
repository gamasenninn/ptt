// WebRTC Audio Stream Client

let ws = null;
let pc = null;
let audioContext = null;
let analyser = null;

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
    updateStatus('接続中...', 'connecting');
    updateButtons(true);

    try {
        // WebSocket接続
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(wsProtocol + '//' + location.host + '/ws');

        ws.onopen = async () => {
            console.log('WebSocket connected');
            await setupWebRTC();
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            console.log('Received:', data.type);

            if (data.type === 'answer') {
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
            console.error('WebSocket error:', error);
            updateStatus('WebSocketエラー', 'error');
            updateButtons(false);
        };

        ws.onclose = () => {
            console.log('WebSocket closed');
            cleanup();
        };

    } catch (error) {
        console.error('Connection error:', error);
        updateStatus('接続エラー: ' + error.message, 'error');
        updateButtons(false);
    }
}

async function setupWebRTC() {
    // RTCPeerConnection作成
    pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });

    // 音声トラック受信時
    pc.ontrack = (event) => {
        console.log('Track received:', event.track.kind);
        const audio = document.getElementById('audio');
        audio.srcObject = event.streams[0];

        // 音量メーター設定
        setupVolumeMeter(event.streams[0]);
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
        console.log('Connection state:', pc.connectionState);
        switch (pc.connectionState) {
            case 'connected':
                updateStatus('接続済み - 音声受信中', 'connected');
                updateButtons(true);
                break;
            case 'connecting':
                updateStatus('接続中...', 'connecting');
                break;
            case 'disconnected':
                updateStatus('切断されました', 'error');
                cleanup();
                break;
            case 'failed':
                updateStatus('接続失敗', 'error');
                cleanup();
                break;
        }
    };

    // 音声受信用のトランシーバーを追加（受信のみ）
    pc.addTransceiver('audio', { direction: 'recvonly' });

    // Offer作成・送信
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
        type: 'offer',
        sdp: offer.sdp
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
    if (ws) {
        ws.close();
    }
    cleanup();
}

function cleanup() {
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

    const audio = document.getElementById('audio');
    if (audio) {
        audio.srcObject = null;
    }
    document.getElementById('volumeBar').style.width = '0%';
    updateStatus('未接続', '');
    updateButtons(false);
}

// ページ離脱時にクリーンアップ
window.addEventListener('beforeunload', cleanup);
