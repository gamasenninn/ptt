# stream_server / stream_client コードレビュー

**レビュー日**: 2026-01-18
**対象**: WebRTC/WebSocket 周りを中心としたバグ、無駄なコード、最適化可能性

---

## サマリー

| カテゴリ | HIGH | MEDIUM | LOW |
|---------|------|--------|-----|
| server.js | 6 | 8 | 5 |
| stream_client | 3 | 6 | 4 |

---

## 1. stream_server (server.js)

### HIGH Priority Issues

#### 1.1 P2P接続削除時のレースコンディション
**場所**: 1191-1196行目

```javascript
p2pConnections.delete(peerId visibleId visibleIdvisibleId);
// 複数の非同期操作が同じMapを同時に変更する可能性
```

**問題**: `p2pConnections.delete()` が複数箇所から呼ばれ、同時アクセスでMapの整合性が崩れる可能性がある。

**推奨修正**: 削除前に存在チェックを追加し、ログで追跡可能にする。

---

#### 1.2 Heartbeatのterminate()レースコンディション
**場所**: 268-281行目

```javascript
client.heartbeatTimeout = setTimeout(() => {
    log(`${client.displayName}: heartbeat timeout, terminating`);
    client.ws.terminate();
}, HEARTBEAT_TIMEOUT);
```

**問題**: タイムアウト発火時にすでに`client.ws`がcloseされている可能性がある。

**推奨修正**:
```javascript
if (client.ws && client.ws.readyState === WebSocket.OPEN) {
    client.ws.terminate();
}
```

---

#### 1.3 PTT状態変更の非アトミック操作
**場所**: 90-106行目 (`PTTManager`クラス)

```javascript
requestFloor(clientId) {
    if (this.currentSpeaker !== null) {
        return false;
    }
    this.currentSpeaker = clientId;  // ← ここまでの間に他のリクエストが来る可能性
    this.speakerStartTime = Date.now();
    return true;
}
```

**問題**: 複数クライアントが同時にrequestFloor()を呼ぶと、両方がtrueを返す可能性がある。

**推奨修正**: フラグまたはミューテックス的なロックを導入。

---

#### 1.4 ファイルパストラバーサル脆弱性
**場所**: 332行目, 362行目

```javascript
app.get('/api/audio', requireAuth, (req, res) => {
    const filename = req.query.file;
    const filepath = path.join(RECORDINGS_DIR, filename);  // ← ../../../etc/passwd 等の攻撃可能
```

**推奨修正**:
```javascript
const safeName = path.basename(filename);  // ディレクトリトラバーサル防止
if (safeName !== filename) {
    return res.status(400).json({ error: 'Invalid filename' });
}
```

---

#### 1.5 パスワードが平文保存
**場所**: 48行目

```javascript
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';
```

**問題**: `.env`ファイルに平文で保存され、ログに出力される可能性もある。

**推奨**: bcryptでハッシュ化して保存・比較。本番環境では必ず変更を促す。

---

#### 1.6 録音クリーンアップのdouble-free
**場所**: 1595-1629行目

```javascript
function cleanupRecording(clientId) {
    const recording = activeRecordings.get(clientId);
    if (recording) {
        // ... cleanup
        activeRecordings.delete(clientId);
    }
}
```

**問題**: 複数箇所から同時に呼ばれると、同じリソースを二重解放する可能性。

---

### MEDIUM Priority Issues

#### 1.7 ICE gathering失敗のサイレント無視
**場所**: 約1100行目付近

WebRTC ICE gatheringが失敗しても明示的なエラーハンドリングがない。接続が静かに失敗する。

---

#### 1.8 メモリリーク - イベントリスナー未削除
**場所**: WebRTC接続作成時

`pc.ontrack`, `pc.onicecandidate`等のイベントリスナーが接続終了時に明示的に削除されていない。

---

#### 1.9 ハードコードされたタイムアウト値
**場所**: 複数箇所

```javascript
const HEARTBEAT_INTERVAL = 25000;
const HEARTBEAT_TIMEOUT = 35000;
```

環境変数化して調整可能にすべき。

---

#### 1.10 エラーレスポンスの不統一
**場所**: APIエンドポイント全般

一部は `{ success: false, error: "..." }`、一部は `{ success: false, reason: "..." }` を返す。

---

#### 1.11 ログローテーションの欠如
**場所**: ログ出力全般

日付でファイルは分かれるが、古いログの自動削除がない。ディスクフルのリスク。

---

#### 1.12 WebSocket closeコードの不統一
**場所**: 複数箇所

`ws.close()`, `ws.close(1000)`, `ws.close(1000, 'reason')` が混在。統一すべき。

---

#### 1.13 セッションの有効期限管理
**場所**: 認証部分

セッションに有効期限がなく、一度ログインすると永続的にアクセス可能。

---

#### 1.14 Opus設定のハードコード
**場所**: 1676-1696行目

```javascript
function createOpusIdHeader() {
    // 48000Hz, 1ch 等がハードコード
}
```

将来的な拡張性のため設定化を検討。

---

### LOW Priority Issues

#### 1.15 未使用変数
- `serialDataBuffer` - 一部のケースでのみ使用

#### 1.16 console.log残存
- デバッグ用のconsole.logが一部残っている

#### 1.17 マジックナンバー
- `5000`, `30000` 等の数値が説明なしで使用されている

#### 1.18 コメントの日英混在
- 一部は日本語、一部は英語コメント

#### 1.19 関数の長さ
- いくつかの関数が100行を超えており、分割を検討すべき

---

## 2. stream_client (js/stream.js)

### HIGH Priority Issues

#### 2.1 ICE gathering時のイベントリスナー未削除（メモリリーク）
**場所**: 510-533行目

```javascript
function waitForIceGathering(pc, timeout = 5000) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
            resolve();
            return;
        }

        const handler = () => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
            }
        };

        pc.addEventListener('icegatheringstatechange', handler);
        // ← handlerが削除されていない！

        setTimeout(resolve, timeout);
    });
}
```

**推奨修正**:
```javascript
const handler = () => {
    if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
    }
};
// タイムアウト時も削除
setTimeout(() => {
    pc.removeEventListener('icegatheringstatechange', handler);
    resolve();
}, timeout);
```

---

#### 2.2 P2P ICEイベントリスナー未削除（メモリリーク）
**場所**: 1674-1679行目

```javascript
pc.addEventListener('icecandidate', (e) => { ... });
pc.addEventListener('iceconnectionstatechange', () => { ... });
// これらがP2P切断時に削除されていない
```

**推奨修正**: `cleanupP2PConnection()` 内でイベントリスナーを明示的に削除。

---

#### 2.3 pendingP2PConnectionsカウンターのレースコンディション
**場所**: 1490-1510行目

```javascript
pendingP2PConnections++;
// ... 非同期処理 ...
pendingP2PConnections--;
```

**問題**: 例外発生時にデクリメントされない可能性がある。

**推奨修正**:
```javascript
pendingP2PConnections++;
try {
    // ... 処理
} finally {
    pendingP2PConnections--;
}
```

---

### MEDIUM Priority Issues

#### 2.4 AudioContext状態チェックの欠如
**場所**: 音声処理全般

```javascript
audioContext.resume();  // ← すでにclosedの場合エラー
```

`audioContext.state` をチェックしてから操作すべき。

---

#### 2.5 再接続時のリソースリーク
**場所**: connect/disconnect処理

再接続時に古いPeerConnection, AudioContext等が完全にクリーンアップされていない可能性。

---

#### 2.6 PTT状態の同期ずれ
**場所**: PTTボタン処理

ネットワーク遅延時にUI状態とサーバー状態がずれる可能性がある。

---

#### 2.7 MediaStreamトラック停止の不完全
**場所**: マイク処理

```javascript
localStream.getTracks().forEach(track => track.stop());
```

一部のパスでこれが呼ばれない可能性がある。

---

#### 2.8 エラーハンドリングの不統一
**場所**: fetch呼び出し全般

一部は try-catch、一部は .catch()、一部はエラーハンドリングなし。

---

#### 2.9 デバッグログの本番残存
**場所**: debugLog()関数

```javascript
function debugLog(msg) {
    console.log('[Stream] ' + msg);
}
```

本番環境では出力を抑制すべき。環境変数で制御を。

---

### LOW Priority Issues

#### 2.10 グローバル変数の多用
- `ws`, `pc`, `localStream` 等がグローバルスコープ
- モジュール化またはクラス化を検討

#### 2.11 定数のハードコード
```javascript
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 2000;
```
設定ファイル化を検討。

#### 2.12 コメントの不足
- 複雑なWebRTC処理にコメントが少ない

#### 2.13 イベント名のマジックストリング
- `'ptt_request'`, `'ptt_release'` 等を定数化すべき

---

## 3. 最適化の機会

### 3.1 WebRTC接続のプーリング
現状、毎回新しいPeerConnectionを作成している。頻繁な再接続時のオーバーヘッドを削減可能。

### 3.2 音声バッファリングの最適化
現状の固定サイズバッファを動的に調整することで、レイテンシ vs 安定性のトレードオフを改善可能。

### 3.3 ログ出力の非同期化
現状の同期的なログ出力を非同期化することで、I/O待ちを削減可能。

### 3.4 状態管理の一元化
クライアント側で散らばっている状態変数をステートマシンパターンで管理することで、状態遷移のバグを防止。

---

## 4. 推奨優先順位

### 即時対応（セキュリティ）
1. ファイルパストラバーサル修正 (1.4)
2. パスワードハッシュ化 (1.5)

### 短期対応（安定性）
3. PTT状態の非アトミック操作修正 (1.3)
4. メモリリーク修正 (2.1, 2.2)
5. レースコンディション修正 (1.1, 2.3)

### 中期対応（品質向上）
6. エラーハンドリング統一
7. ログローテーション実装
8. タイムアウト値の環境変数化

### 長期対応（保守性）
9. コードのモジュール化
10. テストカバレッジ向上

---

## 5. 既存テストとの関連

現在のテストスイート（60テスト）は以下をカバー：
- Phase 1: 純粋関数（utils.test.js）
- Phase 2: PTTManager状態管理（ptt-manager.test.js）
- Phase 3: APIエンドポイント（api.test.js）

**追加が必要なテスト**:
- WebRTC接続/切断のエッジケース
- 同時接続時のレースコンディション
- エラー回復シナリオ

