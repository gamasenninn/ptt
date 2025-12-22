# PTT WebRTC通信システム - 実装知見ドキュメント

## 概要

WebRTCを使用したPTT（Push-To-Talk）双方向通信システムの実装で得た知見をまとめる。

---

## アーキテクチャ

```
stream_server.py (Python/aiohttp)
├── /ws              WebSocket (PTT/P2Pシグナリング)
├── /ws/monitor      モニター用WebSocket
├── /                静的ファイル配信
├── /api/srt/*       SRT API (list/get/save)
└── /api/audio       WAV配信

stream_client/
├── index.html       メインUI（タブ構成）
├── js/stream.js     WebRTC/PTT機能
├── js/history.js    SRT履歴機能
└── js/monitor.js    モニター機能
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
