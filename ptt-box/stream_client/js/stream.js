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

    // 音量の初期値を設定（スライダーのデフォルト値と同期）
    const audio = document.getElementById('audio');
    if (audio) {
        audio.volume = 0.4;  // 40%
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

// 接続トグルボタン制御
function toggleConnection() {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
        connect();
    } else {
        disconnect();
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
            // ========== P2Pシグナリング ==========
            else if (data.type === 'client_list') {
                // 既存クライアントリスト受信 → 各クライアントとP2P接続確立
                handleClientList(data.clients);
            } else if (data.type === 'client_joined') {
                // 新規クライアント参加 → P2P接続確立（相手からofferが来る）
                debugLog('Client joined: ' + data.clientId);
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
                updateConnectionToggle('connected');
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
    // 全P2P接続をクリーンアップ
    cleanupAllP2PConnections();

    if (pc) {
        pc.close();
        pc = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
        analyser = null;
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
    document.getElementById('volumeBar').style.width = '0%';

    // PTT状態リセット
    updatePttState('idle', null);
    enablePttButton(false);
}

// 完全クリーンアップ
function cleanup() {
    cleanupConnection();
    updateConnectionToggle('disconnected');
}

// 自動再接続スケジュール
function scheduleReconnect() {
    if (!autoReconnect) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        debugLog('Max reconnect attempts reached');
        updateConnectionToggle('disconnected');
        return;
    }

    reconnectAttempts++;
    debugLog('Reconnecting in ' + (RECONNECT_DELAY/1000) + 's... (' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ')');
    updateConnectionToggle('connecting');

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

// ボリューム調整
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

    // P2P接続の音声要素も更新
    p2pConnections.forEach((connInfo) => {
        if (connInfo.audioElement) {
            connInfo.audioElement.volume = vol;
        }
    });
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

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        debugLog('WebSocket not connected');
        pttButtonPressed = false;
        return;
    }
    if (!micAccessGranted) {
        debugLog('Microphone not available');
        pttButtonPressed = false;
        return;
    }

    debugLog('PTT request...');
    ws.send(JSON.stringify({ type: 'ptt_request' }));
}

// PTTボタン解放
function pttEnd(event) {
    event.preventDefault();
    event.stopPropagation();

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

// ========== P2P接続管理 ==========

// クライアントリスト受信 → 各クライアントとP2P接続確立
async function handleClientList(clients) {
    debugLog('Client list received: ' + clients.length + ' clients');

    for (const client of clients) {
        if (!p2pConnections.has(client.clientId)) {
            await createP2PConnection(client.clientId, true);  // offerer
        }
    }
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

        // 音量をメインと同じに設定
        const mainAudio = document.getElementById('audio');
        if (mainAudio) {
            audio.volume = mainAudio.volume;
        }

        // 再生を試みる
        audio.play().catch(e => debugLog('P2P audio play error: ' + e.message));
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
        } else if (p2pPc.connectionState === 'failed' || p2pPc.connectionState === 'closed') {
            cleanupP2PConnection(remoteClientId);
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
