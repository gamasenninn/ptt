# PTT WebRTC通信システム - 実装知見ドキュメント

## 概要

WebRTCを使用したPTT（Push-To-Talk）双方向通信システムの実装で得た知見をまとめる。

---

## アーキテクチャ

### Node.js版（現行）

```
stream_server/ (Node.js/werift)
├── server.js        メインサーバー
├── package.json     依存関係
└── .env             設定ファイル

stream_client/
├── index.html       メインUI（タブ構成）
├── js/stream.js     WebRTC/PTT/P2P機能
├── js/history.js    SRT履歴機能
└── js/monitor.js    モニター機能
```

### Python版（旧）

```
stream_server.py (Python/aiohttp)
├── /ws              WebSocket (PTT/P2Pシグナリング)
├── /ws/monitor      モニター用WebSocket
├── /                静的ファイル配信
├── /api/srt/*       SRT API (list/get/save)
└── /api/audio       WAV配信
```

---

## WebRTC実装の知見

### 1. TURN/STUNサーバー設定

モバイル回線や企業ネットワークでは直接接続できないことが多い。TURN必須。

```python
ice_servers = [
    RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
    RTCIceServer(
        urls=[
            f"turn:{TURN_SERVER}?transport=udp",
            f"turn:{TURN_SERVER}?transport=tcp",
            f"turns:{TURN_SERVER}?transport=tcp",
        ],
        username=TURN_USERNAME,
        credential=TURN_PASSWORD
    )
]
```

### 2. ICE Gathering待機

relay候補が取得できたら早めに進む戦略が有効。

```javascript
// relay候補があれば1秒後に進む
if (hasRelay && !relayTimer) {
    relayTimer = setTimeout(() => {
        resolve();
    }, 1000);
}
```

### 3. Opusモノラル設定

リサンプリング問題を回避するためモノラル強制。

```javascript
function forceOpusMono(sdp) {
    // stereo=0;sprop-stereo=0 を追加
}
```

---

## PTT実装の知見

### 1. タッチイベント処理

スマホでは`touchend`が発火しないことがある。`touchcancel`も必須。

```html
<button ontouchstart="pttStart(event)"
        ontouchend="pttEnd(event)"
        ontouchcancel="pttEnd(event)"
        onmousedown="pttStart(event)"
        onmouseup="pttEnd(event)"
        onmouseleave="pttEnd(event)">
```

### 2. デバウンス処理

連続タップで状態が不整合になる問題を防ぐ。

```javascript
let pttDebounceTimer = null;
const PTT_DEBOUNCE_MS = 100;

function pttEnd(event) {
    pttButtonPressed = false;
    pttDebounceTimer = setTimeout(() => {
        pttDebounceTimer = null;
    }, PTT_DEBOUNCE_MS);
}

function pttStart(event) {
    if (pttDebounceTimer) return;  // デバウンス中は無視
}
```

### 3. フラグリセット

接続エラー時にフラグをリセットしないと状態が固まる。

```javascript
if (!ws || ws.readyState !== WebSocket.OPEN) {
    pttButtonPressed = false;  // リセット必須
    return;
}
```

---

## P2Pメッシュ通信の知見

### 1. ICE候補のキューイング

remote descriptionが設定される前にICE候補が届くことがある。

```javascript
const connInfo = {
    pendingCandidates: [],
    remoteDescriptionSet: false
};

// ICE候補受信時
if (!connInfo.remoteDescriptionSet) {
    connInfo.pendingCandidates.push(candidate);
    return;
}

// remote description設定後にキューを処理
for (const candidate of connInfo.pendingCandidates) {
    await connInfo.pc.addIceCandidate(candidate);
}
```

### 2. 音声トラックのクローン

同じトラックを複数の接続で共有するとミュート制御が干渉する。

```javascript
const clonedTrack = track.clone();
clonedTrack.enabled = isPttActive;
connInfo.audioSender = p2pPc.addTrack(clonedTrack, localStream);
```

---

## UI/UXの知見

### 1. CSSの詳細度問題

`button`のデフォルトスタイルが優先されることがある。`!important`で対応。

```css
.connection-toggle.connected {
    background: #1b4332 !important;
}
```

### 2. モバイル向けレイアウト

上部の余白を削減してコンテンツを優先。

```css
body {
    margin: 10px auto;  /* 50px → 10px */
    padding: 10px;      /* 20px → 10px */
}
```

### 3. 接続トグルボタン

状態表示と操作を統合すると直感的。

```
未接続（赤）→ タップで接続
接続中（黄）→ タップでキャンセル
接続済（緑）→ タップで切断
```

---

## マイクゲイン処理

Web Audio APIでGainNodeを使用。

```javascript
micAudioContext = new AudioContext();
const source = micAudioContext.createMediaStreamSource(rawMicStream);
micGainNode = micAudioContext.createGain();
micGainNode.gain.value = MIC_GAIN;

const destination = micAudioContext.createMediaStreamDestination();
source.connect(micGainNode);
micGainNode.connect(destination);

localStream = destination.stream;  // 増幅されたストリーム
```

---

## 内蔵ブラウザ対策

LINE等の内蔵ブラウザでは音声が再生できない。検出して警告表示。

```javascript
const isLine = /Line\//i.test(ua) || /LIFF/i.test(ua);
if (isLine) {
    showInAppBrowserWarning('LINE');
}
```

---

## セキュリティ

### ディレクトリトラバーサル防止

```python
filename = Path(filename).name  # パス区切りを除去
if not re.match(r'^[\w\-]+\.wav$', filename):
    raise ValueError('Invalid file name')
```

---

## 完了した機能

- [x] WebRTC双方向音声通信
- [x] PTT送信権管理
- [x] P2Pメッシュ通信
- [x] リアルタイムモニターページ
- [x] マイクゲインUI
- [x] 接続トグルボタン
- [x] SRT履歴統合（タブUI）
- [x] 音声再生・SRT編集機能
- [x] Node.js版サーバー移行
- [x] P2P音声レベルメーター

---

## Python → Node.js移行の知見

### 1. 移行の動機

Python版（aiortc）ではサーバーマイク音声の送信に問題があった：
- aiortcの`MediaPlayer`でマイク入力を取得しようとしたが、音声が届かない問題が発生
- 原因特定が困難で、ライブラリの成熟度に不安

Node.js版（werift）を選択した理由：
- weriftはより活発にメンテナンスされている
- FFmpegを使ったマイク入力が直接的に扱える
- TypeScript対応で型安全

### 2. werift + FFmpegによるマイク送信

```javascript
const { spawn } = require('child_process');

// FFmpegでマイク入力をOpusエンコード
const ffmpeg = spawn('ffmpeg', [
    '-f', 'dshow',
    '-i', `audio=${MIC_DEVICE}`,
    '-acodec', 'libopus',
    '-ar', '48000',
    '-ac', '1',
    '-application', 'voip',
    '-frame_duration', '20',
    '-f', 'opus',
    '-'
]);

// Opusパケットを読み取ってRTPで送信
const opusReader = new OpusRtpConverter();
ffmpeg.stdout.pipe(opusReader);
opusReader.on('rtp', (packet) => {
    audioTrack.writeRtp(packet);
});
```

### 3. 環境変数の0値処理

JavaScriptの`||`演算子は0をfalsyとして扱うため、タイムアウト値=0（無効化）が機能しない。

```javascript
// NG: 0が300000に置き換わる
const PTT_TIMEOUT = parseInt(process.env.PTT_TIMEOUT) || 300000;

// OK: undefinedの場合のみデフォルト値を使用
const PTT_TIMEOUT = process.env.PTT_TIMEOUT !== undefined
    ? parseInt(process.env.PTT_TIMEOUT)
    : 300000;
```

### 4. WebSocketハートビート

WebSocket接続が約1分で切断される問題が発生。ブラウザやプロキシのタイムアウト対策として30秒間隔のpingを追加。

```javascript
// サーバー側: 30秒ごとにping送信
setInterval(() => {
    for (const client of this.clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.ping();
        }
    }
}, 30000);
```

### 5. サーバーマイクモードの選択

2つの動作モードを環境変数で切り替え可能に：

```env
# 常時送信モード（DTXで無音時は自動停止）
SERVER_MIC_MODE=always

# PTTモード（SPACEキーで送信制御）
SERVER_MIC_MODE=ptt
```

alwaysモードではFFmpegを常時起動し、OpusのDTX（Discontinuous Transmission）機能で無音時のパケット送信を抑制。

---

## P2P音声レベルメーターの知見

### 1. 課題

Python版ではサーバーからの音声が`pc.ontrack`で受信され、既存の`setupVolumeMeter()`が動作した。
Node.js版ではP2P接続経由で音声が配信されるため、別のaudio要素に接続され既存のメーターでは測定できなかった。

### 2. 複数ソースの集約

各P2P接続ごとにAnalyserNodeを作成し、Mapで管理。全ソースの最大レベルをメーターに表示。

```javascript
let p2pMeterSources = new Map();  // clientId -> { source, analyser }

function setupP2PVolumeMeter(stream, clientId) {
    const source = p2pAudioContext.createMediaStreamSource(stream);
    const analyser = p2pAudioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    p2pMeterSources.set(clientId, { source, analyser });
}

function startP2PMeterLoop() {
    function updateP2PMeter() {
        let maxLevel = 0;

        p2pMeterSources.forEach(({ analyser }) => {
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            if (average > maxLevel) maxLevel = average;
        });

        // 最大レベルを表示
        bar.style.width = (maxLevel / 128 * 100) + '%';
        requestAnimationFrame(updateP2PMeter);
    }
    updateP2PMeter();
}
```

### 3. フレームごとのAnalyser再接続の問題

当初、ループ内で毎フレームsource.connect/disconnectしていたが、一度disconnectしたsourceは再接続できない。
Analyserは接続を維持したまま、getByteFrequencyDataのみを呼び出す設計に変更。

### 4. クリーンアップ

P2P切断時とWebSocket切断時にリソースを解放：

```javascript
function cleanupP2PConnection(clientId) {
    // ...
    removeP2PVolumeMeterSource(clientId);  // メーターソース削除
}

function cleanupConnection() {
    p2pMeterRunning = false;
    p2pMeterSources.clear();
    if (p2pAudioContext) {
        p2pAudioContext.close();
        p2pAudioContext = null;
    }
}
```

---

## ICE Restartによるモバイル接続安定化

### 1. 問題の発見

サーバーログ解析で、モバイル端末から**3分間に27回の再接続**が発生していることを発見。

```
03:40:01 Client connected: ptt-trx-xxxx
03:40:03 WebRTC disconnected, closing WebSocket immediately
03:40:05 Client connected: ptt-trx-yyyy  ← 新しいIDで再接続
... 27回繰り返し
```

### 2. 原因

モバイル端末の移動中に発生する**セルタワーハンドオフ**（基地局切り替え）:

1. 端末が移動して別の基地局に接続
2. IPアドレスが変わる
3. 既存のICE候補（IP:ポートの組み合わせ）が無効になる
4. WebRTCのconnectionStateが`disconnected`に
5. 従来の実装: 即座にWebSocketを閉じて完全再接続（3-5秒）

### 3. 解決策: ICE Restart

完全再接続ではなく、**ICE層のみを再ネゴシエーション**する。

```
WebRTC切断検知
    ↓
ICE Restart試行（5秒タイムアウト）
    ↓
┌─────────────┬─────────────────┐
│ 成功        │ 失敗/タイムアウト │
│ 0.5-1秒で回復│ 完全再接続へ     │
│ クライアントID維持│ フォールバック   │
└─────────────┴─────────────────┘
```

### 4. ICEとは

**ICE (Interactive Connectivity Establishment)** はWebRTCの接続経路確立プロトコル:

- **ICE候補**: 接続可能なIP:ポートの組み合わせ
  - `host`: ローカルIPアドレス
  - `srflx` (Server Reflexive): STUNで取得したパブリックIP
  - `relay`: TURNサーバー経由

ICE Restartは、既存のWebRTC接続を維持したまま新しいICE候補を収集・交換する仕組み。

### 5. 実装のポイント

#### クライアント側（stream.js）

```javascript
// 状態変数
let iceRestartInProgress = false;
let iceRestartTimer = null;
const ICE_RESTART_TIMEOUT = 5000;

async function attemptIceRestart() {
    if (iceRestartInProgress || !ws || ws.readyState !== WebSocket.OPEN || !pc) {
        // 条件を満たさない場合は完全再接続
        cleanupConnection();
        scheduleReconnect();
        return;
    }

    iceRestartInProgress = true;

    // タイムアウト設定（失敗時のフォールバック）
    iceRestartTimer = setTimeout(() => {
        iceRestartInProgress = false;
        cleanupConnection();
        scheduleReconnect();
    }, ICE_RESTART_TIMEOUT);

    // ICE Restart: 新しいICE資格情報でOffer作成
    pc.restartIce();  // 内部フラグをセット
    const offer = await pc.createOffer();  // 新ICE資格情報含む
    await pc.setLocalDescription(offer);

    // ICE gathering完了を待ってから送信
    await waitForIceGatheringWithTimeout(3000);

    ws.send(JSON.stringify({
        type: 'ice_restart_offer',
        sdp: pc.localDescription.sdp
    }));
}
```

#### サーバー側（server.js）

```javascript
const ICE_RESTART_TIMEOUT = 5000;

// disconnected時: 即座に閉じずに待機
client.pc.onconnectionstatechange = () => {
    if (client.pc.connectionState === 'disconnected') {
        // ICE Restart処理中はタイマーを開始しない
        if (!client.iceRestartTimer && !client.iceRestartInProgress) {
            client.iceRestartTimer = setTimeout(() => {
                if (client.pc?.connectionState !== 'connected') {
                    client.ws.close(1000, 'ICE restart timeout');
                }
            }, ICE_RESTART_TIMEOUT);
        }
    } else if (client.pc.connectionState === 'connected') {
        // 成功時: タイマーとフラグをクリア
        if (client.iceRestartTimer || client.iceRestartInProgress) {
            clearTimeout(client.iceRestartTimer);
            client.iceRestartTimer = null;
            client.iceRestartInProgress = false;
        }
    }
};

// ICE Restart Offer処理
async handleIceRestartOffer(client, sdp) {
    client.iceRestartInProgress = true;  // タイマー開始を抑制

    clearTimeout(client.iceRestartTimer);
    client.iceRestartTimer = null;

    await client.pc.setRemoteDescription(new RTCSessionDescription(sdp, 'offer'));
    const answer = await client.pc.createAnswer();
    await client.pc.setLocalDescription(answer);

    client.send({
        type: 'ice_restart_answer',
        sdp: client.pc.localDescription.sdp
    });
}
```

### 6. メッセージプロトコル

```
┌─────────┐                    ┌─────────┐
│ Client  │                    │ Server  │
└────┬────┘                    └────┬────┘
     │                              │
     │  connectionState=disconnected│
     │                              │
     │  ice_restart_offer (SDP)     │
     │─────────────────────────────>│
     │                              │
     │  ice_restart_answer (SDP)    │
     │<─────────────────────────────│
     │                              │
     │  connectionState=connected   │
     │                              │
```

### 7. 重要な注意点

#### iceRestartInProgressフラグの必要性

ICE再ネゴシエーション中、サーバー側のRTCPeerConnectionは内部で状態遷移を行う:

```
connected → checking → connected
```

`checking`状態で`disconnected`イベントが発火することがあり、フラグがないとタイマーが重複して開始され、正常な再接続がタイムアウトで失敗する。

#### クライアント側のタイマークリア

Answer受信時に即座にタイマーをクリアする必要がある。`connected`イベントを待つと、その前にタイムアウトが発火する可能性がある。

```javascript
async function handleIceRestartAnswer(sdp) {
    await pc.setRemoteDescription({ type: 'answer', sdp });

    // Answer適用後すぐにクリア（connectedを待たない）
    if (iceRestartTimer) {
        clearTimeout(iceRestartTimer);
        iceRestartTimer = null;
    }
    iceRestartInProgress = false;
}
```

### 8. テスト方法

Chrome DevToolsのオフラインモードはWebSocketも切断するため、ICE Restartのテストには不向き。

手動テスト用にデバッグ関数を公開:

```javascript
// stream.js末尾
window.debugStream = {
    attemptIceRestart,
    getState: () => ({
        wsState: ws?.readyState,
        pcState: pc?.connectionState,
        iceRestartInProgress
    })
};

// コンソールでテスト
debugStream.getState()           // 状態確認
debugStream.attemptIceRestart()  // ICE Restart実行
```

### 9. 期待される効果

| 指標 | 変更前 | 変更後 |
|------|--------|--------|
| 再接続時間 | 3-5秒 | 0.5-1秒 |
| 接続ラッシュ | 27回/3分 | 大幅削減 |
| 音声途切れ | 長い | 短い |
| クライアントID | 毎回変更 | 維持 |
