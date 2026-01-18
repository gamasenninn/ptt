// WebRTC Audio Stream Client with PTT

let ws = null;
let pc = null;
let audioContext = null;
let analyser = null;
let iceServers = null;  // サーバーから受信したICE設定
let debugVisible = false;
let autoReconnect = false;  // 自動再接続フラグ（connect()でtrueに設定）
let reconnectAttempts = 0;
let reconnectTimer = null;  // 再接続タイマーID
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000;  // 基本2秒
const MAX_RECONNECT_DELAY = 30000;  // 最大30秒
let wakeLock = null;  // スクリーンロック防止

// PTT関連
let myClientId = null;
let localStream = null;  // マイク音声ストリーム
let rawMicStream = null;  // 生のマイク入力（クリーンアップ用）
let isPttActive = false;  // PTTボタンが押されているか
let pttState = 'idle';  // idle, transmitting, receiving
let micAccessGranted = false;

// マイクゲイン処理
let micAudioContext = null;
let micGainNode = null;
const MIC_GAIN = 1.0;  // 増幅なし（将来の調整用に残す）

// P2P接続管理
const p2pConnections = new Map();  // clientId -> { pc, audioSender, audioElement }
let pendingP2PConnections = 0;  // P2P接続待ちカウンター
let p2pConnectionTimeout = null;  // P2P接続タイムアウト用タイマー
const P2P_CONNECTION_TIMEOUT_MS = 10000;  // 10秒でタイムアウト

// 接続中クライアント一覧
const connectedClients = new Map();  // clientId -> { clientId, displayName }

// P2P音声レベルメーター用
let p2pAudioContext = null;
let p2pMeterSources = new Map();  // clientId -> { source, analyser }
let p2pMeterRunning = false;

// プッシュ通知用
let pushSubscription = null;
let vapidPublicKey = null;

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

// デバッグボタン表示/非表示
function toggleDebugButtonVisibility(visible) {
    const container = document.getElementById('debugButtonContainer');
    if (container) {
        container.style.display = visible ? 'block' : 'none';
    }
    // ボタン非表示時はデバッグ窓も閉じる
    if (!visible) {
        const debugEl = document.getElementById('debug');
        if (debugEl) {
            debugEl.style.display = 'none';
        }
        debugVisible = false;
    }
    localStorage.setItem('debugButtonVisible', visible ? 'true' : 'false');
}

// デバッグボタン表示設定を読み込み
function loadDebugButtonSetting() {
    const saved = localStorage.getItem('debugButtonVisible');
    const visible = saved === 'true';
    const container = document.getElementById('debugButtonContainer');
    const toggle = document.getElementById('debugButtonToggle');
    if (container) {
        container.style.display = visible ? 'block' : 'none';
    }
    if (toggle) {
        toggle.checked = visible;
    }
}

// PTTボタン表示/非表示
function togglePttButtonVisibility(visible) {
    const container = document.getElementById('pttContainer');
    if (container) {
        container.style.display = visible ? 'block' : 'none';
    }
    localStorage.setItem('pttButtonVisible', visible ? 'true' : 'false');
}

// PTTボタン表示設定を読み込み
function loadPttButtonSetting() {
    const saved = localStorage.getItem('pttButtonVisible');
    // デフォルトは表示（true）
    const visible = saved !== 'false';
    const container = document.getElementById('pttContainer');
    const toggle = document.getElementById('pttButtonToggle');
    if (container) {
        container.style.display = visible ? 'block' : 'none';
    }
    if (toggle) {
        toggle.checked = visible;
    }
}

// 保存された音量設定を読み込み
function loadVolumeSetting() {
    // PCストリーム音量
    const savedVolume = localStorage.getItem('volumeSlider');
    const volumeSlider = document.getElementById('volumeSlider');
    const audio = document.getElementById('audio');
    if (savedVolume !== null) {
        const vol = parseInt(savedVolume, 10);
        if (volumeSlider) volumeSlider.value = vol;
        if (audio) audio.volume = vol / 100;
        const volumeValue = document.getElementById('volumeValue');
        if (volumeValue) volumeValue.textContent = vol + '%';
    } else if (audio) {
        audio.volume = 0.4;  // デフォルト40%
    }

    // P2P音量
    const savedP2PVolume = localStorage.getItem('p2pVolumeSlider');
    const p2pVolumeSlider = document.getElementById('p2pVolumeSlider');
    if (savedP2PVolume !== null) {
        const vol = parseInt(savedP2PVolume, 10);
        if (p2pVolumeSlider) p2pVolumeSlider.value = vol;
        const p2pVolumeValue = document.getElementById('p2pVolumeValue');
        if (p2pVolumeValue) p2pVolumeValue.textContent = vol + '%';
    }

    // マイクゲイン
    const savedMicGain = localStorage.getItem('micGainSlider');
    const micGainSlider = document.getElementById('micGainSlider');
    if (savedMicGain !== null) {
        const val = parseInt(savedMicGain, 10);
        if (micGainSlider) micGainSlider.value = val;
        const micGainValue = document.getElementById('micGainValue');
        if (micGainValue) micGainValue.textContent = (val / 100).toFixed(1) + 'x';
    }
}

// ページ読み込み時にデバッグ領域をクリア
window.addEventListener('DOMContentLoaded', () => {
    const debugEl = document.getElementById('debug');
    if (debugEl) {
        debugEl.innerHTML = '';
    }

    // 保存された音量設定を読み込み
    loadVolumeSetting();

    // LINEなどの内蔵ブラウザを検出
    checkInAppBrowser();

    // キーボードショートカット設定
    setupKeyboardShortcuts();

    // デバッグボタン表示設定を読み込み
    loadDebugButtonSetting();

    // PTTボタン表示設定を読み込み
    loadPttButtonSetting();
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

// 接続トグルボタン制御
function toggleConnection() {
    // autoReconnect=true（再接続待機中含む）または接続中なら切断
    if (autoReconnect || (ws && ws.readyState !== WebSocket.CLOSED)) {
        disconnect();
    } else {
        connect();
    }
}

function updateConnectionToggle(state) {
    const toggle = document.getElementById('connectionToggle');
    if (!toggle) return;

    const text = toggle.querySelector('.connection-text');
    toggle.className = 'connection-toggle ' + state;

    switch (state) {
        case 'disconnected':
            text.textContent = '未接続 - タップで接続';
            break;
        case 'connecting':
            text.textContent = '接続中... - タップでキャンセル';
            break;
        case 'preparing':
            text.textContent = '準備中 - タップで切断';
            break;
        case 'connected':
            text.textContent = '接続済み - タップで切断';
            break;
    }
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
    updateConnectionToggle('connecting');

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
                vapidPublicKey = data.vapidPublicKey;
                debugLog('Client ID: ' + myClientId);
                debugLog('ICE servers: ' + JSON.stringify(iceServers.map(s => s.urls)));
                await setupWebRTC();

                // 保存された表示名をサーバーに送信
                const savedName = getSavedDisplayName();
                if (savedName) {
                    ws.send(JSON.stringify({
                        type: 'set_display_name',
                        displayName: savedName
                    }));
                    debugLog('Display name sent: ' + savedName);
                }

                // プッシュ通知をセットアップ
                if (vapidPublicKey) {
                    setupPushNotifications();
                }
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
            // ========== P2Pシグナリング ==========
            else if (data.type === 'client_list') {
                // 既存クライアントリスト受信 → 各クライアントとP2P接続確立
                handleClientList(data.clients);
            } else if (data.type === 'client_joined') {
                // 新規クライアント参加 → P2P接続確立（相手からofferが来る）
                debugLog('Client joined: ' + data.clientId);
                connectedClients.set(data.clientId, {
                    clientId: data.clientId,
                    displayName: data.displayName
                });
                updateClientsBadge();
            } else if (data.type === 'client_left') {
                // クライアント切断 → P2P接続クリーンアップ
                handleClientLeft(data.clientId);
            } else if (data.type === 'p2p_offer') {
                // P2P Offer受信
                handleP2POffer(data.from, data.sdp);
            } else if (data.type === 'p2p_answer') {
                // P2P Answer受信
                handleP2PAnswer(data.from, data.sdp);
            } else if (data.type === 'p2p_ice_candidate') {
                // P2P ICE候補受信
                handleP2PIceCandidate(data.from, data.candidate);
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
        updateConnectionToggle('disconnected');
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
                updateConnectionToggle('preparing');  // P2P接続完了まで「準備中」
                startP2PConnectionTimeout();  // タイムアウト開始（client_list未着でも対応）
                enablePttButton(true);
                reconnectAttempts = 0;  // 接続成功でリセット
                requestWakeLock();  // スクリーンオフ防止
                break;
            case 'connecting':
                updateConnectionToggle('connecting');
                break;
            case 'disconnected':
                updateConnectionToggle('disconnected');
                enablePttButton(false);
                cleanupConnection();
                scheduleReconnect();
                break;
            case 'failed':
                updateConnectionToggle('disconnected');
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

    // Offer作成（Opusをモノラルに設定してリサンプル回避）
    const offer = await pc.createOffer();
    const monoSdp = forceOpusMono(offer.sdp);
    await pc.setLocalDescription({ type: 'offer', sdp: monoSdp });

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
        // モバイルではsuspended状態で開始されることがあるためresumeを呼ぶ
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function updateMeter() {
            if (!analyser) return;

            // AudioContextがsuspendedなら再開を試みる（バックグラウンド後の復帰対策）
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }

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

// P2P音声レベルメーター（複数ストリーム対応）
function setupP2PVolumeMeter(stream, clientId) {
    try {
        // AudioContextがなければ作成
        if (!p2pAudioContext) {
            p2pAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        // モバイルではsuspended状態で開始されることがあるためresumeを呼ぶ
        if (p2pAudioContext.state === 'suspended') {
            p2pAudioContext.resume();
        }

        // 既存のソースがあれば切断
        if (p2pMeterSources.has(clientId)) {
            const old = p2pMeterSources.get(clientId);
            try { old.source.disconnect(); } catch (e) {}
        }

        // 新しいソースとAnalyserを作成して接続
        const source = p2pAudioContext.createMediaStreamSource(stream);
        const analyser = p2pAudioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        p2pMeterSources.set(clientId, { source, analyser });

        // メーター更新ループが動いていなければ開始
        if (!p2pMeterRunning) {
            p2pMeterRunning = true;
            startP2PMeterLoop();
        }

        debugLog('P2P volume meter added: ' + clientId);
    } catch (e) {
        console.warn('P2P volume meter setup failed:', e);
    }
}

function startP2PMeterLoop() {
    const dataArray = new Uint8Array(128);  // fftSize 256 → frequencyBinCount 128
    const NOISE_THRESHOLD = 8;  // ノイズ閾値（この値以下は0%として表示）

    function updateP2PMeter() {
        if (!p2pMeterRunning) return;

        // AudioContextがsuspendedなら再開を試みる（バックグラウンド後の復帰対策）
        if (p2pAudioContext && p2pAudioContext.state === 'suspended') {
            p2pAudioContext.resume();
        }

        let maxLevel = 0;

        // 各ストリームの音量を計測
        p2pMeterSources.forEach(({ analyser }) => {
            try {
                analyser.getByteFrequencyData(dataArray);
                const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

                if (average > maxLevel) {
                    maxLevel = average;
                }
            } catch (e) {}
        });

        // PTTがidle時は常に0%表示（無通信時のノイズ対策）
        // VOX連携により外部デバイス送信時もpttStateがtransmittingになる
        const percentage = (pttState !== 'idle' && maxLevel > NOISE_THRESHOLD)
            ? Math.min(100, (maxLevel / 128) * 100)
            : 0;
        const bar = document.getElementById('p2pVolumeBar');
        if (bar) {
            bar.style.width = percentage + '%';
        }

        requestAnimationFrame(updateP2PMeter);
    }

    updateP2PMeter();
}

function removeP2PVolumeMeterSource(clientId) {
    if (p2pMeterSources.has(clientId)) {
        const { source } = p2pMeterSources.get(clientId);
        try { source.disconnect(); } catch (e) {}
        p2pMeterSources.delete(clientId);
        debugLog('P2P volume meter removed: ' + clientId);
    }
}

function disconnect() {
    autoReconnect = false;  // 手動切断時は自動再接続しない
    reconnectAttempts = 0;
    // 再接続タイマーをキャンセル
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    releaseWakeLock();  // Wake Lock解放
    if (ws) {
        ws.close(1000, 'User disconnect');
    }
    cleanup();
}

// 接続リソースのみクリーンアップ（自動再接続用）
function cleanupConnection() {
    // P2P接続タイムアウトをクリア
    clearP2PConnectionTimeout();
    pendingP2PConnections = 0;

    // 全P2P接続をクリーンアップ
    cleanupAllP2PConnections();

    // クライアント一覧クリア
    connectedClients.clear();
    updateClientsBadge();

    if (pc) {
        pc.close();
        pc = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
        analyser = null;
    }

    // P2P音声レベルメーター用AudioContextをクリーンアップ
    p2pMeterRunning = false;
    p2pMeterSources.clear();
    if (p2pAudioContext) {
        p2pAudioContext.close();
        p2pAudioContext = null;
    }

    // マイクゲイン用AudioContextをクリーンアップ
    if (micAudioContext) {
        micAudioContext.close();
        micAudioContext = null;
        micGainNode = null;
    }
    // 生のマイクストリームを停止
    if (rawMicStream) {
        rawMicStream.getTracks().forEach(track => track.stop());
        rawMicStream = null;
    }
    localStream = null;
    micAccessGranted = false;

    ws = null;
    iceServers = null;
    isPttActive = false;

    const audio = document.getElementById('audio');
    if (audio) {
        audio.srcObject = null;
    }
    const volumeBar = document.getElementById('volumeBar');
    if (volumeBar) volumeBar.style.width = '0%';
    const p2pVolumeBar = document.getElementById('p2pVolumeBar');
    if (p2pVolumeBar) p2pVolumeBar.style.width = '0%';

    // PTT状態リセット
    updatePttState('idle', null);
    enablePttButton(false);
}

// 完全クリーンアップ
function cleanup() {
    cleanupConnection();
    updateConnectionToggle('disconnected');
}

// 自動再接続スケジュール（指数バックオフ）
function scheduleReconnect() {
    if (!autoReconnect) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        debugLog('Max reconnect attempts reached');
        updateConnectionToggle('disconnected');
        return;
    }

    // 指数バックオフ: 2秒, 4秒, 8秒, 16秒, 30秒(上限)...
    const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;

    debugLog('Reconnecting in ' + (delay/1000) + 's... (' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ')');
    updateConnectionToggle('connecting');

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (autoReconnect && !ws) {
            connect();
        }
    }, delay);
}

// ページ離脱時にクリーンアップ
window.addEventListener('beforeunload', () => {
    autoReconnect = false;
    cleanup();
});

// SDPを修正してOpusをモノラルに強制
function forceOpusMono(sdp) {
    // Opusのペイロードタイプを探す
    const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
    if (!opusMatch) {
        debugLog('Opus not found in SDP');
        return sdp;
    }
    const opusPayloadType = opusMatch[1];
    debugLog('Opus payload type: ' + opusPayloadType);

    // 既存のfmtpがあれば修正、なければ追加
    const fmtpRegex = new RegExp('a=fmtp:' + opusPayloadType + ' (.+)');
    if (fmtpRegex.test(sdp)) {
        sdp = sdp.replace(fmtpRegex, 'a=fmtp:' + opusPayloadType + ' $1;stereo=0;sprop-stereo=0');
    } else {
        // fmtpがない場合、rtpmapの後に追加
        sdp = sdp.replace(
            new RegExp('(a=rtpmap:' + opusPayloadType + ' opus/48000/2)'),
            '$1\r\na=fmtp:' + opusPayloadType + ' stereo=0;sprop-stereo=0'
        );
    }

    debugLog('SDP modified for mono');
    return sdp;
}

// ボリューム調整（PCストリーム用 = サーバーからのP2P音声）
function setVolume(value) {
    const audio = document.getElementById('audio');
    const volumeValue = document.getElementById('volumeValue');
    const vol = value / 100;

    if (audio) {
        audio.volume = vol;
    }
    if (volumeValue) {
        volumeValue.textContent = value + '%';
    }

    // サーバーからのP2P音声要素を更新
    const serverConn = p2pConnections.get('server');
    if (serverConn && serverConn.audioElement) {
        serverConn.audioElement.volume = vol;
    }

    // localStorageに保存
    localStorage.setItem('volumeSlider', value);
}

// P2P音声ボリューム調整（クライアント同士）
function setP2PVolume(value) {
    const volumeValue = document.getElementById('p2pVolumeValue');
    const vol = value / 100;

    if (volumeValue) {
        volumeValue.textContent = value + '%';
    }

    // サーバー以外のP2P接続の音声要素を更新
    p2pConnections.forEach((connInfo, clientId) => {
        if (clientId !== 'server' && connInfo.audioElement) {
            connInfo.audioElement.volume = vol;
        }
    });

    // localStorageに保存
    localStorage.setItem('p2pVolumeSlider', value);
}

// マイクゲイン調整
function setMicGain(value) {
    const gain = value / 100;  // 50-300 → 0.5-3.0
    if (micGainNode) {
        micGainNode.gain.value = gain;
    }
    const gainValue = document.getElementById('micGainValue');
    if (gainValue) {
        gainValue.textContent = gain.toFixed(1) + 'x';
    }

    // localStorageに保存
    localStorage.setItem('micGainSlider', value);
}

// ========== キーボードショートカット ==========

let pttKeyActive = false;  // キーボードからPTTが有効か
let pttKeyConfig = { ctrlKey: true, code: 'Space' };  // デフォルト: Ctrl+Space
let isKeyRegistrationMode = false;  // キー登録モード

// 設定をlocalStorageから読み込み
function loadPttKeyConfig() {
    const saved = localStorage.getItem('pttKeyConfig');
    if (saved) {
        try {
            pttKeyConfig = JSON.parse(saved);
            debugLog('PTT key loaded: ' + getPttKeyDisplayName());
        } catch (e) {
            debugLog('Failed to load PTT key config');
        }
    }
}

// 設定をlocalStorageに保存
function savePttKeyConfig() {
    localStorage.setItem('pttKeyConfig', JSON.stringify(pttKeyConfig));
}

// PTTキーの表示名を取得
function getPttKeyDisplayName() {
    let name = '';
    if (pttKeyConfig.ctrlKey) name += 'Ctrl+';
    if (pttKeyConfig.altKey) name += 'Alt+';
    if (pttKeyConfig.shiftKey) name += 'Shift+';
    name += pttKeyConfig.code.replace('Key', '').replace('Digit', '');
    return name;
}

// 設定画面を開く
function openSettings() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.add('active');
        updatePttKeyDisplay();
        loadDisplayNameToInput();
    }
}

// 設定画面を閉じる
function closeSettings() {
    const modal = document.getElementById('settingsModal');
    if (modal) {
        modal.classList.remove('active');
    }
    cancelKeyRegistration();
}

// ========== 表示名設定 ==========

// 保存された表示名を取得
function getSavedDisplayName() {
    return localStorage.getItem('ptt_display_name') || '';
}

// 表示名を保存
function saveDisplayName() {
    const input = document.getElementById('displayNameInput');
    if (!input) return;

    const name = input.value.trim();
    if (name) {
        localStorage.setItem('ptt_display_name', name);
        // サーバーに通知
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'set_display_name',
                displayName: name
            }));
        }
        // フィードバック表示
        const hint = document.getElementById('displayNameHint');
        if (hint) {
            hint.textContent = '保存しました';
            hint.style.color = '#4ade80';
            setTimeout(() => {
                hint.textContent = '他のユーザーに表示される名前です';
                hint.style.color = '#888';
            }, 2000);
        }
        debugLog('Display name saved: ' + name);
    }
}

// 設定画面を開いた時に表示名を読み込み
function loadDisplayNameToInput() {
    const input = document.getElementById('displayNameInput');
    if (input) {
        input.value = getSavedDisplayName();
    }
}

// PTTキー表示を更新
function updatePttKeyDisplay() {
    const display = document.getElementById('pttKeyDisplay');
    if (display) {
        display.textContent = getPttKeyDisplayName();
    }
}

// キー登録モード開始
function startKeyRegistration() {
    isKeyRegistrationMode = true;
    const hint = document.getElementById('keyRegistrationHint');
    const btn = document.getElementById('registerKeyBtn');
    if (hint) hint.style.display = 'block';
    if (btn) {
        btn.textContent = 'キャンセル';
        btn.onclick = cancelKeyRegistration;
    }
}

// キー登録キャンセル
function cancelKeyRegistration() {
    isKeyRegistrationMode = false;
    const hint = document.getElementById('keyRegistrationHint');
    const btn = document.getElementById('registerKeyBtn');
    if (hint) hint.style.display = 'none';
    if (btn) {
        btn.textContent = '登録';
        btn.onclick = startKeyRegistration;
    }
}

// キー登録処理
function registerPttKey(event) {
    if (!isKeyRegistrationMode) return false;

    // Escapeでキャンセル
    if (event.code === 'Escape') {
        cancelKeyRegistration();
        return true;
    }

    // 修飾キーのみは無視
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
        return true;
    }

    pttKeyConfig = {
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        code: event.code
    };

    savePttKeyConfig();
    updatePttKeyDisplay();
    cancelKeyRegistration();
    debugLog('PTT key registered: ' + getPttKeyDisplayName());
    return true;
}

// PTTキーが押されたか判定
function isPttKeyPressed(event) {
    return (!!pttKeyConfig.ctrlKey === event.ctrlKey) &&
           (!!pttKeyConfig.altKey === event.altKey) &&
           (!!pttKeyConfig.shiftKey === event.shiftKey) &&
           (pttKeyConfig.code === event.code);
}

// PTTキーが離されたか判定（修飾キーまたはメインキーが離された）
function isPttKeyReleased(event) {
    if (pttKeyConfig.code === event.code) return true;
    if (pttKeyConfig.ctrlKey && event.key === 'Control') return true;
    if (pttKeyConfig.altKey && event.key === 'Alt') return true;
    if (pttKeyConfig.shiftKey && event.key === 'Shift') return true;
    return false;
}

function setupKeyboardShortcuts() {
    // 保存された設定を読み込み
    loadPttKeyConfig();

    document.addEventListener('keydown', (event) => {
        // キー登録モード
        if (isKeyRegistrationMode) {
            event.preventDefault();
            registerPttKey(event);
            return;
        }

        // PTTキーでPTT開始
        if (isPttKeyPressed(event)) {
            event.preventDefault();
            if (!pttKeyActive) {
                pttKeyActive = true;
                pttStart(event);
            }
        }
    });

    document.addEventListener('keyup', (event) => {
        // PTTキーが離されたらPTT終了
        if (pttKeyActive && isPttKeyReleased(event)) {
            event.preventDefault();
            pttKeyActive = false;
            pttEnd(event);
        }
    });

    // ウィンドウがフォーカスを失ったらPTT終了
    window.addEventListener('blur', () => {
        if (pttKeyActive) {
            pttKeyActive = false;
            pttEnd(new Event('blur'));
        }
    });

    debugLog('Keyboard shortcut: ' + getPttKeyDisplayName() + ' for PTT');
}

// ========== PTT機能 ==========

// マイクアクセス要求（GainNodeで増幅）
async function requestMicrophoneAccess() {
    if (localStream) return true;  // 既に取得済み

    try {
        // 生のマイク入力を取得
        rawMicStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000,
                channelCount: 1
            }
        });

        // AudioContextでゲイン処理
        micAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = micAudioContext.createMediaStreamSource(rawMicStream);
        micGainNode = micAudioContext.createGain();
        micGainNode.gain.value = MIC_GAIN;

        // 出力先を作成
        const destination = micAudioContext.createMediaStreamDestination();
        source.connect(micGainNode);
        micGainNode.connect(destination);

        // 増幅されたストリームを使用
        localStream = destination.stream;
        micAccessGranted = true;

        // 実際に取得したフォーマットをログ出力
        const track = rawMicStream.getAudioTracks()[0];
        const settings = track.getSettings();
        debugLog('Mic: ' + settings.sampleRate + 'Hz, ' + settings.channelCount + 'ch, gain=' + MIC_GAIN);

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
let pttButtonPressed = false;  // ボタンが物理的に押されているか
let pttDebounceTimer = null;   // デバウンス用タイマー
const PTT_DEBOUNCE_MS = 100;   // デバウンス時間

function pttStart(event) {
    event.preventDefault();
    event.stopPropagation();

    // デバウンス中は無視
    if (pttDebounceTimer) return;

    if (pttButtonPressed) return;  // 既に押されている
    pttButtonPressed = true;

    // ポインターキャプチャ（モバイルでpointerupを確実に受け取る）
    if (event.target && event.pointerId !== undefined) {
        event.target.setPointerCapture(event.pointerId);
    }

    // 外側リングの押下状態を視覚的に表示
    const pttRing = document.getElementById('pttRing');
    if (pttRing) pttRing.classList.add('active');
    const pttBtn = document.getElementById('pttBtn');
    if (pttBtn) pttBtn.classList.add('pressing');

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        debugLog('WebSocket not connected');
        pttButtonPressed = false;
        if (pttRing) pttRing.classList.remove('active');
        if (pttBtn) pttBtn.classList.remove('pressing');
        return;
    }
    if (!micAccessGranted) {
        debugLog('Microphone not available');
        pttButtonPressed = false;
        if (pttRing) pttRing.classList.remove('active');
        if (pttBtn) pttBtn.classList.remove('pressing');
        return;
    }

    debugLog('PTT request...');
    ws.send(JSON.stringify({ type: 'ptt_request' }));
}

// PTTボタン解放
function pttEnd(event) {
    event.preventDefault();
    event.stopPropagation();

    debugLog('pttEnd called: ' + event.type);  // デバッグ用

    // ポインターキャプチャ解放
    if (event.target && event.pointerId !== undefined) {
        try {
            event.target.releasePointerCapture(event.pointerId);
        } catch (e) {}  // 既に解放されている場合は無視
    }

    // 外側リングの押下状態を解除
    const pttRing = document.getElementById('pttRing');
    if (pttRing) pttRing.classList.remove('active');

    // ボタンの押下状態を解除し、フォーカスをボタンに移動
    const pttBtn = document.getElementById('pttBtn');
    if (pttBtn) {
        pttBtn.classList.remove('pressing');
        pttBtn.focus();  // 内側ボタンにフォーカス移動（sticky状態回避）
    }

    if (!pttButtonPressed) return;  // 押されていない
    pttButtonPressed = false;

    // デバウンス: 短時間での再押下を防ぐ
    pttDebounceTimer = setTimeout(() => {
        pttDebounceTimer = null;
    }, PTT_DEBOUNCE_MS);

    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!isPttActive) return;  // 送信権を持っていない

    debugLog('PTT release');
    isPttActive = false;

    // サーバー向けマイクをミュート
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = false;
        });
    }

    // 全P2P接続のマイクトラックを無効化
    p2pConnections.forEach((connInfo, clientId) => {
        if (connInfo.audioSender && connInfo.audioSender.track) {
            connInfo.audioSender.track.enabled = false;
        }
    });

    ws.send(JSON.stringify({ type: 'ptt_release' }));
}

// 送信権取得時
function handlePttGranted() {
    debugLog('PTT granted - transmitting');

    // ボタンが既に離されていたら即座にリリース
    if (!pttButtonPressed) {
        debugLog('Button already released - immediate release');
        ws.send(JSON.stringify({ type: 'ptt_release' }));
        return;
    }

    isPttActive = true;

    // サーバー向けマイクをアンミュート
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = true;
        });
    }

    // 全P2P接続のマイクトラックを有効化
    p2pConnections.forEach((connInfo, clientId) => {
        if (connInfo.audioSender && connInfo.audioSender.track) {
            connInfo.audioSender.track.enabled = true;
            debugLog('P2P track enabled for ' + clientId);
        }
    });

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
    const pttRing = document.getElementById('pttRing');
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

    // 外側リングのクラス更新
    if (pttRing) {
        pttRing.classList.remove('active', 'transmitting', 'receiving');
        if (state === 'transmitting') {
            pttRing.classList.add('transmitting');
        } else if (state === 'receiving') {
            pttRing.classList.add('receiving');
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

// ========== P2P接続管理 ==========

// P2P接続タイムアウトをクリア
function clearP2PConnectionTimeout() {
    if (p2pConnectionTimeout) {
        clearTimeout(p2pConnectionTimeout);
        p2pConnectionTimeout = null;
    }
}

// P2P接続タイムアウトを設定
function startP2PConnectionTimeout() {
    clearP2PConnectionTimeout();
    p2pConnectionTimeout = setTimeout(() => {
        if (pendingP2PConnections > 0) {
            debugLog('P2P connection timeout, forcing connected state (pending: ' + pendingP2PConnections + ')');
            pendingP2PConnections = 0;
            updateConnectionToggle('connected');
        }
    }, P2P_CONNECTION_TIMEOUT_MS);
}

// クライアントリスト受信 → 各クライアントとP2P接続確立
async function handleClientList(clients) {
    debugLog('Client list received: ' + clients.length + ' clients');

    // クライアント一覧を更新
    connectedClients.clear();

    // 新規に接続するクライアント数をカウント
    const newClients = clients.filter(c => !p2pConnections.has(c.clientId));
    pendingP2PConnections = newClients.length;

    // 他クライアントがいない場合は即座に「接続済み」
    if (pendingP2PConnections === 0) {
        updateConnectionToggle('connected');
    } else {
        // P2P接続待ちがある場合はタイムアウトを設定
        startP2PConnectionTimeout();
    }

    for (const client of clients) {
        connectedClients.set(client.clientId, {
            clientId: client.clientId,
            displayName: client.displayName
        });

        if (!p2pConnections.has(client.clientId)) {
            await createP2PConnection(client.clientId, true);  // offerer
        }
    }
    updateClientsBadge();
}

// P2P接続作成
async function createP2PConnection(remoteClientId, isOfferer) {
    debugLog('Creating P2P to ' + remoteClientId + ' (offerer: ' + isOfferer + ')');

    const p2pPc = new RTCPeerConnection({
        iceServers: iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const connInfo = {
        pc: p2pPc,
        audioSender: null,
        audioElement: null,
        pendingCandidates: [],  // remote descriptionが設定されるまでICE候補をキュー
        remoteDescriptionSet: false
    };
    p2pConnections.set(remoteClientId, connInfo);

    // ローカルマイクトラックを追加（ミュート状態）
    if (localStream) {
        const track = localStream.getAudioTracks()[0];
        if (track) {
            const clonedTrack = track.clone();
            clonedTrack.enabled = isPttActive;  // PTT状態に応じて
            connInfo.audioSender = p2pPc.addTrack(clonedTrack, localStream);
            debugLog('P2P track added (enabled: ' + clonedTrack.enabled + ')');
        }
    }

    // リモート音声受信
    p2pPc.ontrack = (event) => {
        debugLog('P2P track received from ' + remoteClientId + ', streams: ' + event.streams.length);

        // 音声再生用要素を作成
        let audio = document.getElementById('p2p-audio-' + remoteClientId);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'p2p-audio-' + remoteClientId;
            audio.autoplay = true;
            audio.playsInline = true;
            audio.style.display = 'none';
            document.body.appendChild(audio);
        }

        // ストリームがある場合はそれを使用、ない場合はトラックから作成
        if (event.streams.length > 0) {
            audio.srcObject = event.streams[0];
        } else {
            // ストリームがない場合、トラックから新しいストリームを作成
            const stream = new MediaStream([event.track]);
            audio.srcObject = stream;
            debugLog('Created MediaStream from track');
        }
        connInfo.audioElement = audio;

        // サーバーかクライアントかで適用する音量スライダーを分ける
        if (remoteClientId === 'server') {
            // PCストリーム音量を適用
            const volumeSlider = document.getElementById('volumeSlider');
            if (volumeSlider) {
                audio.volume = volumeSlider.value / 100;
            }
        } else {
            // P2P音量を適用
            const p2pSlider = document.getElementById('p2pVolumeSlider');
            if (p2pSlider) {
                audio.volume = p2pSlider.value / 100;
            }
        }

        // 再生を試みる
        audio.play().catch(e => debugLog('P2P audio play error: ' + e.message));

        // P2P音声のレベルメーターを設定（すべてのP2P接続で有効）
        const stream = audio.srcObject;
        if (stream) {
            setupP2PVolumeMeter(stream, remoteClientId);
        }
    };

    // ICE候補をサーバー経由で送信
    p2pPc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'p2p_ice_candidate',
                to: remoteClientId,
                candidate: {
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex
                }
            }));
        }
    };

    // 接続状態変化
    p2pPc.onconnectionstatechange = () => {
        debugLog('P2P to ' + remoteClientId + ': ' + p2pPc.connectionState);
        if (p2pPc.connectionState === 'connected') {
            debugLog('✓ P2P connected to ' + remoteClientId);
            // P2P接続完了カウンターをデクリメント
            if (pendingP2PConnections > 0) {
                pendingP2PConnections--;
                debugLog('Pending P2P connections: ' + pendingP2PConnections);
                if (pendingP2PConnections === 0) {
                    clearP2PConnectionTimeout();
                    updateConnectionToggle('connected');
                }
            }
        } else if (p2pPc.connectionState === 'failed' || p2pPc.connectionState === 'closed' || p2pPc.connectionState === 'disconnected') {
            // P2P接続失敗/切断時もカウンターをデクリメント
            // Note: モバイルでは 'disconnected' に遷移することがある
            if (pendingP2PConnections > 0) {
                pendingP2PConnections--;
                debugLog('P2P ' + p2pPc.connectionState + ', pending: ' + pendingP2PConnections);
                if (pendingP2PConnections === 0) {
                    clearP2PConnectionTimeout();
                    updateConnectionToggle('connected');
                }
            }
            if (p2pPc.connectionState !== 'disconnected') {
                cleanupP2PConnection(remoteClientId);
            }
        }
    };

    // Offerer側: Offer作成・送信
    if (isOfferer) {
        const offer = await p2pPc.createOffer();
        const monoSdp = forceOpusMono(offer.sdp);
        await p2pPc.setLocalDescription({ type: 'offer', sdp: monoSdp });

        // ICE gathering完了を待つ
        await waitForP2PIceGathering(p2pPc);

        ws.send(JSON.stringify({
            type: 'p2p_offer',
            to: remoteClientId,
            sdp: p2pPc.localDescription.sdp
        }));
        debugLog('P2P offer sent to ' + remoteClientId);
    }

    return connInfo;
}

// P2P Offer受信時
async function handleP2POffer(fromClientId, sdp) {
    debugLog('P2P offer from ' + fromClientId);

    let connInfo = p2pConnections.get(fromClientId);
    if (!connInfo) {
        connInfo = await createP2PConnection(fromClientId, false);
    }

    await connInfo.pc.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: sdp
    }));

    // remote descriptionが設定されたことをマーク
    connInfo.remoteDescriptionSet = true;

    // キューに溜まったICE候補を処理
    for (const candidate of connInfo.pendingCandidates) {
        try {
            await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            debugLog('P2P ICE (queued) error: ' + e.message);
        }
    }
    connInfo.pendingCandidates = [];

    const answer = await connInfo.pc.createAnswer();
    const monoSdp = forceOpusMono(answer.sdp);
    await connInfo.pc.setLocalDescription({ type: 'answer', sdp: monoSdp });

    // ICE gathering完了を待つ
    await waitForP2PIceGathering(connInfo.pc);

    ws.send(JSON.stringify({
        type: 'p2p_answer',
        to: fromClientId,
        sdp: connInfo.pc.localDescription.sdp
    }));
    debugLog('P2P answer sent to ' + fromClientId);
}

// P2P Answer受信時
async function handleP2PAnswer(fromClientId, sdp) {
    debugLog('P2P answer from ' + fromClientId);

    const connInfo = p2pConnections.get(fromClientId);
    if (connInfo) {
        await connInfo.pc.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: sdp
        }));

        // remote descriptionが設定されたことをマーク
        connInfo.remoteDescriptionSet = true;

        // キューに溜まったICE候補を処理
        for (const candidate of connInfo.pendingCandidates) {
            try {
                await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                debugLog('P2P ICE (queued) error: ' + e.message);
            }
        }
        connInfo.pendingCandidates = [];

        debugLog('P2P connection established with ' + fromClientId);
    }
}

// P2P ICE候補受信時
async function handleP2PIceCandidate(fromClientId, candidate) {
    let connInfo = p2pConnections.get(fromClientId);

    // まだ接続がない場合は作成（answerer側で先にICE候補が届く場合）
    if (!connInfo) {
        connInfo = await createP2PConnection(fromClientId, false);
    }

    if (connInfo && candidate) {
        // remote descriptionが設定されていない場合はキューに追加
        if (!connInfo.remoteDescriptionSet) {
            connInfo.pendingCandidates.push(candidate);
            return;
        }

        try {
            await connInfo.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            debugLog('P2P ICE error: ' + e.message);
        }
    }
}

// クライアント切断時
function handleClientLeft(clientId) {
    debugLog('Client left: ' + clientId);
    connectedClients.delete(clientId);
    updateClientsBadge();
    cleanupP2PConnection(clientId);
}

// P2P接続クリーンアップ
function cleanupP2PConnection(clientId) {
    const connInfo = p2pConnections.get(clientId);
    if (connInfo) {
        if (connInfo.pc) {
            connInfo.pc.close();
        }
        if (connInfo.audioElement) {
            connInfo.audioElement.srcObject = null;
            connInfo.audioElement.remove();
        }
        p2pConnections.delete(clientId);

        // レベルメーターのソースもクリーンアップ
        removeP2PVolumeMeterSource(clientId);

        debugLog('P2P cleanup: ' + clientId);
    }
}

// 全P2P接続クリーンアップ
function cleanupAllP2PConnections() {
    p2pConnections.forEach((_, clientId) => {
        cleanupP2PConnection(clientId);
    });
}

// P2P ICE gathering待機
async function waitForP2PIceGathering(p2pPc) {
    if (p2pPc.iceGatheringState === 'complete') return;

    return new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);  // 最大5秒

        p2pPc.addEventListener('icegatheringstatechange', () => {
            if (p2pPc.iceGatheringState === 'complete') {
                clearTimeout(timeout);
                resolve();
            }
        });
    });
}

// ========== クライアント一覧UI ==========

// バッジ更新
function updateClientsBadge() {
    const badge = document.getElementById('clientsBadge');
    const count = connectedClients.size;

    if (badge) {
        badge.textContent = count + '人';
        if (count > 0) {
            badge.classList.add('visible');
        } else {
            badge.classList.remove('visible');
        }
    }

    // ポップアップが開いていたら更新
    const popup = document.getElementById('clientsPopup');
    if (popup && popup.classList.contains('active')) {
        renderClientsPopup();
    }
}

// ポップアップ表示
function showClientsPopup() {
    const popup = document.getElementById('clientsPopup');
    const overlay = document.getElementById('clientsOverlay');

    if (popup && overlay) {
        renderClientsPopup();
        popup.classList.add('active');
        overlay.classList.add('active');
    }
}

// ポップアップ非表示
function hideClientsPopup() {
    const popup = document.getElementById('clientsPopup');
    const overlay = document.getElementById('clientsOverlay');

    if (popup) popup.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
}

// ポップアップ内容描画
function renderClientsPopup() {
    const body = document.getElementById('clientsPopupBody');
    const countEl = document.getElementById('clientsPopupCount');

    if (countEl) {
        countEl.textContent = connectedClients.size;
    }

    if (!body) return;

    if (connectedClients.size === 0) {
        body.innerHTML = '<div class="no-clients-popup">接続中のクライアントはいません</div>';
        return;
    }

    let html = '';
    connectedClients.forEach((client) => {
        const name = client.displayName || client.clientId;
        html += `
            <div class="client-item-popup">
                <span class="client-icon">📱</span>
                <span class="client-name-popup">${escapeHtmlForClients(name)}</span>
            </div>
        `;
    });
    body.innerHTML = html;
}

// HTMLエスケープ（クライアント一覧用）
function escapeHtmlForClients(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== プッシュ通知 ==========

// VAPID公開鍵をUint8Arrayに変換
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// プッシュ通知セットアップ
async function setupPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        debugLog('Push notifications not supported');
        return;
    }

    try {
        const registration = await navigator.serviceWorker.ready;
        debugLog('SW ready for push');

        // 既存のsubscriptionを確認
        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
            // 通知許可を確認
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                debugLog('Notification permission denied');
                return;
            }

            // 新しいsubscriptionを作成
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
            });
            debugLog('Push subscribed');
        } else {
            debugLog('Push already subscribed');
        }

        pushSubscription = subscription;

        // サーバーにsubscriptionを送信
        sendPushSubscription(subscription);

    } catch (error) {
        debugLog('Push setup error: ' + error.message);
    }
}

// サーバーにsubscriptionを送信
function sendPushSubscription(subscription) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
        type: 'push_subscribe',
        subscription: subscription.toJSON()
    }));
    debugLog('Push subscription sent to server');
}
