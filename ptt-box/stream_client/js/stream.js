// WebRTC Audio Stream Client with PTT

let ws = null;
let pc = null;
let audioContext = null;
let analyser = null;
let iceServers = null;  // サーバーから受信したICE設定
let debugVisible = false;
let autoReconnect = true;  // 自動再接続フラグ
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;  // 3秒
let wakeLock = null;  // スクリーンロック防止

// PTT関連
let myClientId = null;
let localStream = null;  // マイク音声ストリーム
let isPttActive = false;  // PTTボタンが押されているか
let pttState = 'idle';  // idle, transmitting, receiving
let micAccessGranted = false;

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

    // LINEなどの内蔵ブラウザを検出
    checkInAppBrowser();
});

// 内蔵ブラウザ検出
function checkInAppBrowser() {
    const ua = navigator.userAgent || navigator.vendor;
    debugLog('UA: ' + ua);

    const isLine = /Line\//i.test(ua) || /LIFF/i.test(ua);
    const isFacebook = ua.includes('FBAN') || ua.includes('FBAV');
    const isInstagram = ua.includes('Instagram');
    const isTwitter = ua.includes('Twitter');

    if (isLine || isFacebook || isInstagram || isTwitter) {
        const appName = isLine ? 'LINE' : isFacebook ? 'Facebook' : isInstagram ? 'Instagram' : 'Twitter';
        showInAppBrowserWarning(appName);
    }
}

// 警告表示
function showInAppBrowserWarning(appName) {
    const warning = document.createElement('div');
    warning.id = 'inapp-warning';
    warning.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#ff6b6b;color:white;padding:15px;text-align:center;z-index:9999;font-size:14px;';
    warning.innerHTML = `
        <div style="margin-bottom:8px;"><strong>${appName}の内蔵ブラウザでは音声が再生できません</strong></div>
        <div style="font-size:12px;">右下の「︙」→「ブラウザで開く」を選択してください</div>
    `;
    document.body.prepend(warning);
}

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
                // サーバーからICE設定とクライアントIDを受信
                iceServers = data.iceServers;
                myClientId = data.clientId;
                debugLog('Client ID: ' + myClientId);
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
            } else if (data.type === 'ptt_granted') {
                // 送信権取得
                handlePttGranted();
            } else if (data.type === 'ptt_denied') {
                // 送信権拒否
                handlePttDenied(data.speakerName);
            } else if (data.type === 'ptt_status') {
                // PTT状態更新
                handlePttStatus(data);
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
    // マイクアクセス要求
    await requestMicrophoneAccess();

    // RTCPeerConnection作成（サーバーから受信したICE設定を使用）
    pc = new RTCPeerConnection({
        iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // マイクトラックを追加（ミュート状態で開始）
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = false;  // ミュート状態で開始
            pc.addTrack(track, localStream);
            debugLog('Local audio track added (muted)');
        });
    }

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
                updateStatus('接続済み', 'connected');
                updateButtons(true);
                enablePttButton(true);
                reconnectAttempts = 0;  // 接続成功でリセット
                requestWakeLock();  // スクリーンオフ防止
                break;
            case 'connecting':
                updateStatus('接続中...', 'connecting');
                break;
            case 'disconnected':
                updateStatus('切断されました', 'error');
                enablePttButton(false);
                cleanupConnection();
                scheduleReconnect();
                break;
            case 'failed':
                updateStatus('接続失敗', 'error');
                enablePttButton(false);
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

    // 双方向音声用のトランシーバーを追加
    if (!localStream) {
        // マイクがない場合は受信のみ
        pc.addTransceiver('audio', { direction: 'recvonly' });
    }

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
    isPttActive = false;

    const audio = document.getElementById('audio');
    if (audio) {
        audio.srcObject = null;
    }
    document.getElementById('volumeBar').style.width = '0%';

    // PTT状態リセット
    updatePttState('idle', null);
    enablePttButton(false);
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

// ========== PTT機能 ==========

// マイクアクセス要求
async function requestMicrophoneAccess() {
    if (localStream) return true;  // 既に取得済み

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        micAccessGranted = true;
        debugLog('Microphone access granted');
        return true;
    } catch (err) {
        debugLog('Microphone access denied: ' + err.message);
        micAccessGranted = false;
        return false;
    }
}

// PTTボタンの有効/無効
function enablePttButton(enabled) {
    const pttBtn = document.getElementById('pttBtn');
    if (pttBtn) {
        pttBtn.disabled = !enabled || !micAccessGranted;
    }
}

// PTTボタン押下開始
function pttStart(event) {
    event.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!micAccessGranted) {
        debugLog('Microphone not available');
        return;
    }
    if (isPttActive) return;  // 既に押されている

    debugLog('PTT request...');
    ws.send(JSON.stringify({ type: 'ptt_request' }));
}

// PTTボタン解放
function pttEnd(event) {
    event.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!isPttActive) return;

    debugLog('PTT release');
    isPttActive = false;

    // マイクをミュート
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = false;
        });
    }

    ws.send(JSON.stringify({ type: 'ptt_release' }));
}

// 送信権取得時
function handlePttGranted() {
    debugLog('PTT granted - transmitting');
    isPttActive = true;

    // マイクをアンミュート
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = true;
        });
    }

    updatePttState('transmitting', 'あなた');
}

// 送信権拒否時
function handlePttDenied(speakerName) {
    debugLog('PTT denied - ' + speakerName + ' is speaking');
    isPttActive = false;
}

// PTT状態更新（サーバーからのブロードキャスト）
function handlePttStatus(data) {
    debugLog('PTT status: ' + data.state + ' - ' + (data.speakerName || 'none'));

    if (data.speaker === myClientId) {
        // 自分が送信中
        updatePttState('transmitting', 'あなた');
    } else if (data.state === 'transmitting') {
        // 他の人が送信中
        updatePttState('receiving', data.speakerName);
    } else {
        // 待機中
        updatePttState('idle', null);
    }
}

// PTT状態のUI更新
function updatePttState(state, speakerName) {
    pttState = state;

    const pttBtn = document.getElementById('pttBtn');
    const speakerNameEl = document.getElementById('speakerName');
    const speakerIndicator = document.getElementById('speakerIndicator');

    // PTTボタンのクラス更新
    if (pttBtn) {
        pttBtn.className = 'ptt-button';
        if (state === 'transmitting') {
            pttBtn.classList.add('transmitting');
        } else if (state === 'receiving') {
            pttBtn.classList.add('receiving');
        }
    }

    // インジケーター更新
    if (speakerIndicator) {
        speakerIndicator.className = 'speaker-indicator';
        if (state === 'transmitting' || state === 'receiving') {
            speakerIndicator.classList.add(state);
        }
    }

    // 送信者名表示更新
    if (speakerNameEl) {
        switch (state) {
            case 'idle':
                speakerNameEl.textContent = '待機中';
                break;
            case 'transmitting':
                speakerNameEl.textContent = '送信中: ' + speakerName;
                break;
            case 'receiving':
                speakerNameEl.textContent = '受信中: ' + speakerName;
                break;
        }
    }
}
