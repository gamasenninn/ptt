# AIアシスタントとトランシーバーの疎結合化

**実施日**: 2026-02-22
**ブランチ**: feature/agent-enhancement

---

## 概要

AIアシスタント機能をWebSocket/WebRTC接続から独立させ、HTTP SSE (Server-Sent Events) で直接動作するように変更した。
これにより、トランシーバー未接続の状態でもAIクエリが利用可能になった。

---

## 変更内容

### 1. server.js — HTTP SSEプロキシ追加

| エンドポイント | 用途 |
|---------------|------|
| `POST /api/ai/query_stream` | AIクエリのSSEストリーミングプロキシ |
| `POST /api/ai/stop_tts` | TTS停止（HTTP版） |

Python AIサービスの `/query_stream` は元々SSEレスポンスを返している。
従来はNode.jsがSSE→WebSocketに変換して中継していたが、新エンドポイントではSSEをそのままクライアントにパイプする。

### 2. assistant.js — sendAIQuery() HTTP SSE化

- `ws.readyState` チェックを削除（WebSocket不要に）
- `fetch` + `ReadableStream` でSSEを直接受信
- `AbortController` による中断機能を追加（新クエリ送信時に前回を中断）
- 既存の `handleAIStreamEvent()` をそのまま再利用（`type` → `eventType` マッピング）

### 3. stopAITTS() — HTTP フォールバック追加

- WebSocket接続時は従来通りWS経由で停止
- 未接続時は `POST /api/ai/stop_tts` にHTTPフォールバック
- 進行中のSSEストリームも `AbortController.abort()` で中断

---

## 得られた知見

### Node.js fetch の ReadableStream

Node.js 22の `fetch` が返す `response.body` は **Web ReadableStream** であり、Node.js の Stream ではない。
そのため `.pipe()` が使えず、`Readable.fromWeb()` で変換が必要。

```javascript
// NG: response.body.pipe is not a function
response.body.pipe(res);

// OK: Web ReadableStream → Node Readable に変換
const { Readable } = require('stream');
const nodeStream = Readable.fromWeb(response.body);
nodeStream.pipe(res);
```

これは Node.js 16以前（node-fetch使用）からの移行時によくあるハマりポイント。

### SSEのイベント型マッピング

Python AIサービスのSSEイベントは `{ type: 'text', delta: '...' }` の形式で返る。
WebSocket経由の場合、server.js が `type` を `eventType` にリネームしていた（`type: 'ai_stream_event'` との衝突回避）。

HTTP SSEで直接受信する場合は、クライアント側で同じマッピングが必要:

```javascript
handleAIStreamEvent({
    ...eventData,
    eventType: eventData.type  // SSEのtypeをeventTypeに変換
});
```

### TTSモードの自動フォールバック

WebSocket未接続時は `server` TTSモード（WebRTC経由）が使えない。
`sendAIQuery()` 内で接続状態を判定し、自動的に `edge` にフォールバックすることで、
ユーザーが意識せずにTTSが動作する。

---

## 後方互換性

- WebSocket版の `handleAIQueryStream` (server.js) はそのまま残存
- `processAIMessage()` (assistant.js) も変更なし — WebSocket経由のイベントも引き続き処理可能
- 既存のWebSocketクライアントは影響を受けない

---

## 現在の結合度マップ（更新後）

### WebSocket **不要**（HTTP独立動作）

| 機能 | 通信方式 |
|------|----------|
| AIクエリ送受信（ストリーミング） | `POST /api/ai/query_stream` (SSE) |
| テキスト整形 | `POST /api/refine` |
| TTS停止 | `POST /api/ai/stop_tts` |
| 音声入力 | ブラウザ Web Speech API |
| Edge TTS | `POST /api/tts/edge` |
| クライアントTTS | ブラウザ speechSynthesis |

### WebSocket **必須**（変更なし）

| 機能 | 理由 |
|------|------|
| サーバーTTS音声再生 | WebRTC P2Pオーディオトラック経由 |
| PTT送信/受信 | WebRTC音声ストリーム |

---

## 未対応タスク

### 優先度: 低

1. **session_id の活用**
   - 現在 `sendAIQuery()` は `session_id` を送信していない（Python側はデフォルト `'default'` を使用）
   - 複数セッション管理が必要になった場合に対応

2. **WebSocket版ハンドラの整理**
   - `handleAIQueryStream` (server.js) と `processAIMessage` の `ai_stream_event` ハンドラは後方互換のため残存
   - 全クライアントがHTTP SSEに移行完了後、削除を検討

3. **AI機能の独立ページ化**
   - 現在AIタブはトランシーバーUIの一部（`index.html` 内のタブ）
   - HTTP独立動作が実現したため、AI専用の軽量ページ（`/ai` など）を作成可能
   - トランシーバーのJS/CSSを読み込まない軽量版

4. **AbortSignal.timeout の改善**
   - 現在 `AI_ASSISTANT_TIMEOUT` (30秒) でSSEプロキシ全体にタイムアウトを設定
   - 長時間のツール実行（MCP）ではタイムアウトする可能性
   - Python側の処理時間に応じた適切なタイムアウト戦略が必要

---

## テスト手順

1. Node.jsサーバー + Python AIサービスを起動
2. ブラウザでWebトランシーバーを開く
3. **WebSocket接続せずに** AIタブでクエリ送信 → SSEストリーミング応答を確認
4. Edge TTS / クライアントTTSで音声再生を確認
5. WebSocket接続中も従来通り動作すること（後方互換）
6. ストリーミング中にTTS停止ボタン → ストリームが中断されること
