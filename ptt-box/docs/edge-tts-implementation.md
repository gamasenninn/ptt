# Edge TTS 実装知見

## 概要

Microsoft Edge のニューラルTTS音声をブラウザから利用する機能。APIキー不要・無料で高品質な日本語音声合成を実現する。

---

## アーキテクチャ

### サーバーサイドプロキシ方式

```
クライアント                    サーバー (Node.js)              Microsoft TTS
    │                              │                              │
    │ POST /api/tts/edge           │                              │
    │  { text, voice }             │                              │
    │ ──────────────────────────→  │                              │
    │                              │  WebSocket接続               │
    │                              │  (Edge User-Agent)           │
    │                              │ ────────────────────────────→ │
    │                              │                              │
    │                              │  ← MP3オーディオデータ       │
    │                              │ ←──────────────────────────── │
    │                              │                              │
    │  ← audio/mpeg (MP3バイナリ)  │                              │
    │ ←────────────────────────────│                              │
    │                              │                              │
    │  new Audio(blob).play()      │                              │
    │  (ブラウザ内で再生)          │                              │
```

### サーバーの役割

**テキストを受け取り、MP3を返す変換プロキシのみ。**

- 音声合成はMicrosoft側で実行（サーバーCPU/メモリ負荷ほぼゼロ）
- 再生タイミング、キュー管理、停止制御は全てクライアント側
- サーバーは状態を持たない（ステートレス）
- 1文あたりのMP3は数KB〜数十KB程度

---

## 重要な知見: ブラウザ直接接続が不可能な理由

### 当初の計画

`edge-tts-universal` ライブラリ (~30KB) を使い、ブラウザからMSのTTSサービスに直接WebSocket接続する予定だった。

### 失敗した原因

**2025年12月、MicrosoftがEdge TTS APIに破壊的変更を実施:**

1. **Edge User-Agent必須化** — WebSocket接続時に Microsoft Edge のUser-Agentヘッダーが必要になった
2. **認証要件の変更** — 新しい認証パラメータが追加された
3. **ブラウザWebSocketの制約** — ブラウザの `WebSocket` APIはカスタムヘッダーを設定できない

これにより、ブラウザから直接MSのTTSサービスへ接続する方式は**根本的に不可能**となった。

### 関連情報

- `edge-tts-universal` v1.3.3 (2025年11月) — 最後のリリース。MS APIの変更以前のため動作しない
- Python `edge-tts` 7.2.4〜7.2.7 (2025年12月) — 修正済み
- Node.js `@andresaya/edge-tts` (2025年12月) — エンドポイント切替で対応済み
- GitHub Issue: https://github.com/travisvn/edge-tts-universal/issues/19

### 教訓

> ブラウザから第三者WebSocketサービスに直接接続する設計は、サービス側の認証変更で突然動作しなくなるリスクがある。Node.jsサーバーを中継する方式の方が、ヘッダー制御が可能で安定性が高い。

---

## 既存TTSモードとの比較

| | サーバーTTS | サーバーTTS (ストリーミング) | 端末TTS (Web Speech) | Edge TTS |
|---|---|---|---|---|
| **合成場所** | Python (OpenAI等) | Python (OpenAI等) | ブラウザ内蔵 | MS Edge (サーバー中継) |
| **配信方式** | WebRTC P2Pストリーム | WebRTC P2Pストリーム | ブラウザ内再生 | HTTP → ブラウザ内再生 |
| **音声品質** | 高 | 高 | 低（ロボット的） | 高（ニューラル音声） |
| **制御主体** | サーバー（キュー管理） | サーバー（キュー管理） | クライアント | クライアント |
| **停止方法** | `ai_stop_tts` WS送信 | `ai_stop_tts` WS送信 | `speechSynthesis.cancel()` | `audio.pause()` |
| **コスト** | API利用料 | API利用料 | 無料 | 無料 |
| **サーバー負荷** | Python TTS処理 | Python TTS処理 | なし | HTTP中継のみ（微小） |
| **ネットワーク** | WebRTC | WebRTC | 不要 | HTTP (数KB〜数十KB/文) |

---

## 実装詳細

### サーバー側 (`server.js`)

```javascript
// POST /api/tts/edge — 変換プロキシ
// 依存: @andresaya/edge-tts
this.app.post('/api/tts/edge', async (req, res) => {
    const { text, voice } = req.body;
    const { EdgeTTS } = require('@andresaya/edge-tts');
    const tts = new EdgeTTS();
    await tts.synthesize(text, voice || 'ja-JP-NanamiNeural');
    const buffer = tts.toBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
});
```

### クライアント側 (`assistant.js`)

文ごとにサーバーへfetch → MP3をAudio要素で再生 → onendedで次の文へ。

```javascript
async function playEdgeTTS(text) {
    const voice = localStorage.getItem('edge_tts_voice') || 'ja-JP-NanamiNeural';
    const resp = await fetch('/api/tts/edge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice })
    });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);

    return new Promise((resolve, reject) => {
        edgeTTSAudio = new Audio(url);
        edgeTTSAudio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        edgeTTSAudio.onerror = () => { URL.revokeObjectURL(url); reject(); };
        edgeTTSAudio.play().catch(reject);
    });
}
```

### 音声キュー処理フロー

```
AIテキストデルタ受信
  ↓
aiClientTTSBuffer に蓄積
  ↓
文境界検出（。！？!?\n）→ aiClientTTSQueue に追加
  ↓
processClientTTSQueue()
  ↓ ttsMode === 'edge' の場合
playEdgeTTS(sentence)  ← fetch /api/tts/edge → MP3 → Audio.play()
  ↓ onended
次の文へ（キューが空になるまで繰り返し）
```

### 利用可能な音声

| Voice ID | 名前 | 性別 |
|----------|------|------|
| `ja-JP-NanamiNeural` | Nanami | 女性 |
| `ja-JP-KeitaNeural` | Keita | 男性 |

---

## 設定

### ユーザー設定（localStorage）

| キー | 値 | デフォルト |
|------|-----|-----------|
| `ptt_tts_mode` | `'edge'` | `'server'` |
| `edge_tts_voice` | `'ja-JP-NanamiNeural'` | `'ja-JP-NanamiNeural'` |

### サーバー依存パッケージ

```json
// ptt-box/stream_server/package.json
"@andresaya/edge-tts": "^1.8.0"
```

---

## トラブルシューティング

### Edge TTSが動作しない場合

1. **サーバーログを確認** — `Edge TTS error:` で検索
2. **サーバー再起動** — `npm install` 後に再起動が必要
3. **ネットワーク確認** — サーバーからMSのTTSサービスへの接続が必要
4. **ライブラリ更新** — MSがAPIを変更した場合、`@andresaya/edge-tts` の更新が必要

### MSのAPI変更への対応

MicrosoftはEdge TTS APIを予告なく変更することがある。動作しなくなった場合：

1. `@andresaya/edge-tts` のGitHubで最新版を確認
2. `npm update @andresaya/edge-tts` で更新
3. 代替ライブラリ: `node-edge-tts` (v1.2.10+) もAPI変更に対応済み
