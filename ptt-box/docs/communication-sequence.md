# PTT WebRTC通信シーケンス図

このドキュメントでは、PTTシステムの主要な通信フローをシーケンス図で説明します。

---

## 目次

1. [システム構成](#システム構成)
2. [初期接続フロー](#初期接続フロー)
3. [PTT送信フロー](#ptt送信フロー)
4. [P2P音声配信フロー](#p2p音声配信フロー)
5. [ICE Restartフロー](#ice-restartフロー)
6. [切断・クリーンアップフロー](#切断クリーンアップフロー)

---

## システム構成

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Client A   │     │   Server    │     │  Client B   │
│  (スマホ)    │     │  (Node.js)  │     │  (スマホ)    │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │◄─── WebSocket ───►│◄─── WebSocket ───►│
       │                   │                   │
       │◄─── WebRTC ──────►│◄─── WebRTC ──────►│
       │   (メイン接続)      │   (メイン接続)      │
       │                   │                   │
       │◄─── P2P接続 ─────►│◄─── P2P接続 ─────►│
       │   (音声受信用)      │   (音声受信用)      │
```

### 接続の役割

| 接続 | 方向 | 用途 |
|------|------|------|
| WebSocket | 双方向 | シグナリング、PTT制御、状態通知 |
| メインWebRTC | Client → Server | クライアント音声送信 |
| P2P接続 | Server → Client | サーバーからの音声配信 |

---

## 初期接続フロー

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: 1. WebSocket接続
    C->>S: WebSocket接続要求
    S->>C: 接続確立
    S->>C: config {clientId, iceServers, vapidPublicKey}
    C->>S: set_display_name {displayName} (保存名がある場合)
    S-->>S: broadcast: client_joined (他クライアントへ)

    Note over C,S: 2. メインWebRTC接続 (Client = Offerer)
    C->>C: createOffer()
    C->>S: offer {sdp}
    S->>S: setRemoteDescription(offer)
    S->>S: createAnswer()
    S->>C: answer {sdp}
    C->>C: setRemoteDescription(answer)

    Note over C,S: 3. ICE候補交換
    C->>S: ice-candidate {candidate}
    S->>C: ice-candidate {candidate}
    Note over C,S: (複数回繰り返し)

    Note over C,S: 4. WebRTC接続確立
    C->>C: connectionState = connected
    S->>S: connectionState = connected

    Note over C,S: 5. P2P接続 (Server = Offerer)
    S->>S: createP2PConnection()
    S->>S: createOffer()
    S->>C: p2p_offer {sdp}
    C->>C: setRemoteDescription(offer)
    C->>C: createAnswer()
    C->>S: p2p_answer {sdp}
    S->>S: setRemoteDescription(answer)

    Note over C,S: 6. P2P ICE候補交換
    S->>C: p2p_ice_candidate {candidate}
    C->>S: p2p_ice_candidate {candidate}

    Note over C,S: 7. P2P接続確立
    S->>S: P2P connectionState = connected
    C->>C: P2P connectionState = connected
```

---

## PTT送信フロー

```mermaid
sequenceDiagram
    participant A as Client A (送信者)
    participant S as Server
    participant B as Client B (受信者)

    Note over A,B: PTT開始
    A->>S: ptt_request
    S->>S: PTT状態チェック (idle?)
    S->>A: ptt_granted
    S->>B: ptt_status {state: receiving, speaker: A}

    Note over A,B: 音声送信
    A->>A: マイク音声取得
    A->>S: WebRTC Audio Track (Opus)
    S->>S: 音声受信・処理

    Note over A,B: 音声配信 (P2P経由)
    S->>B: P2P Audio Track (Opus)
    Note right of B: スピーカー再生

    Note over A,B: アナログ出力 (オプション)
    S->>S: FFmpeg → スピーカー出力
    Note right of S: 無線機へ送信

    Note over A,B: PTT終了
    A->>S: ptt_release
    S-->>A: ptt_status {state: idle}
    S-->>B: ptt_status {state: idle}
```

### PTT状態遷移

```
        ptt_request (granted)
idle ─────────────────────────► receiving
  ▲                                  │
  │                                  │
  │         ptt_release              │
  └──────────────────────────────────┘
```

---

## P2P音声配信フロー

### パターン1: サーバーマイク/外部デバイス(VOX)の音声配信

```mermaid
sequenceDiagram
    participant R as 無線機 (外部)
    participant S as Server
    participant A as Client A
    participant B as Client B

    Note over R,B: 外部デバイス(VOX)またはサーバーPTT中

    R->>S: アナログ音声入力
    S->>S: FFmpeg Opusエンコード

    Note over S: P2P経由で全クライアントに配信
    S->>A: P2P Opus送信
    S->>B: P2P Opus送信

    Note over A,B: 各クライアントで再生
    A->>A: スピーカー出力
    B->>B: スピーカー出力
```

### パターン2: Webクライアントの音声送信

```mermaid
sequenceDiagram
    participant A as Client A (送信者)
    participant S as Server
    participant R as 無線機 (外部)
    participant B as Client B

    Note over A,B: Client AがPTT送信中

    A->>S: Opus音声パケット (WebRTC)

    Note over S: サーバーマイク音声を全ブロック
    S->>S: エコーループ防止

    S->>R: スピーカー出力 → 無線送信
    S->>B: P2P Opus送信 (Aには送らない)

    Note over B: 他クライアントで再生
    B->>B: スピーカー出力
```

### エコー防止ロジック

```javascript
sendOpusToClients(opusData) {
    const currentSpeaker = this.pttManager.currentSpeaker;

    // WebクライアントがPTT中は、サーバーマイク音声を一切送信しない
    // (スピーカー出力 → 無線機マイク → サーバーマイク のエコーループ防止)
    if (currentSpeaker &&
        currentSpeaker !== this.serverClientId &&
        currentSpeaker !== 'external') {
        return;  // 早期リターンで全送信をブロック
    }

    for (const [clientId, connInfo] of this.p2pConnections) {
        // 送信者には送らない（自分の声が戻るのを防ぐ）
        if (currentSpeaker === clientId) continue;

        connInfo.audioTrack.writeRtp(rtpBuffer);
    }
}
```

### エコー防止の動作一覧

| PTT状態 | サーバーマイク音声 | 理由 |
|---------|-------------------|------|
| idle | ✅ 全員に送信 | 通常動作 |
| external (VOX) | ✅ 全員に送信 | 無線受信音声を配信 |
| server | ✅ server以外に送信 | サーバーPTT |
| Webクライアント | ❌ 全ブロック | エコーループ防止 |

---

## ICE Restartフロー

モバイル端末の移動時などにWebRTC接続が切断された場合、完全再接続ではなくICE Restartで高速回復を試みます。

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: ネットワーク変化検知
    C->>C: connectionState = disconnected
    S->>S: connectionState = disconnected

    Note over S: サーバー側タイマー開始 (5秒)
    S->>S: iceRestartTimer = setTimeout(5000)

    Note over C,S: ICE Restart試行
    C->>C: pc.restartIce()
    C->>C: createOffer() (新ICE credentials)
    C->>S: ice_restart_offer {sdp}

    S->>S: タイマーキャンセル
    S->>S: setRemoteDescription(offer)
    S->>S: createAnswer()
    S->>C: ice_restart_answer {sdp}

    C->>C: setRemoteDescription(answer)

    Note over C,S: 新ICE候補で再接続
    C->>S: ice-candidate (新候補)
    S->>C: ice-candidate (新候補)

    Note over C,S: 接続回復
    C->>C: connectionState = connected
    S->>S: connectionState = connected

    Note over C,S: 成功: クライアントID維持、0.5-1秒で回復
```

### ICE Restart失敗時のフォールバック

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    C->>C: connectionState = disconnected
    S->>S: iceRestartTimer = setTimeout(5000)

    Note over C: ICE Restart試行失敗
    C->>C: (ネットワーク不安定でOffer送信できず)

    Note over S: 5秒タイムアウト
    S->>S: タイマー満了
    S->>C: WebSocket close (ICE restart timeout)

    Note over C,S: 完全再接続へフォールバック
    C->>C: cleanupConnection()
    C->>C: scheduleReconnect()
    C->>S: 新規WebSocket接続
    Note over C,S: 初期接続フローへ戻る
```

---

## 切断・クリーンアップフロー

### 正常切断

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: ユーザーが切断ボタンを押す
    C->>S: WebSocket close

    S->>S: handleDisconnect()
    S->>S: PTT状態クリア (送信中なら)
    S->>S: ICE Restartタイマークリア
    S->>S: P2Pクリーンアップタイマークリア
    S->>S: P2P接続close
    S->>S: メインWebRTC close
    S->>S: クライアントMapから削除

    S-->>S: broadcast: client_left
```

### P2P Disconnectedタイムアウト

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: P2P接続が不安定に
    S->>S: P2P connectionState = disconnected
    S->>S: cleanupTimer = setTimeout(10000)

    alt 10秒以内に回復
        S->>S: P2P connectionState = connected
        S->>S: clearTimeout(cleanupTimer)
        Note over S: 継続使用
    else 10秒経過
        S->>S: タイマー満了
        S->>S: P2P接続をMapから削除
        S->>S: P2P PeerConnection close
        Note over S: クリーンアップ完了
    end
```

---

## メッセージ一覧

### WebSocket メッセージ (Client → Server)

| type | 説明 | パラメータ |
|------|------|-----------|
| set_display_name | 表示名設定 | displayName |
| offer | WebRTC Offer | sdp |
| ice-candidate | ICE候補 | candidate |
| ice_restart_offer | ICE Restart Offer | sdp |
| p2p_answer | P2P Answer | sdp |
| p2p_ice_candidate | P2P ICE候補 | candidate |
| ptt_request | PTT取得要求 | - |
| ptt_release | PTT解放 | - |
| push_subscribe | Push通知登録 | subscription |

### WebSocket メッセージ (Server → Client)

| type | 説明 | パラメータ |
|------|------|-----------|
| config | 初期設定 | clientId, iceServers, vapidPublicKey |
| answer | WebRTC Answer | sdp |
| ice-candidate | ICE候補 | candidate |
| ice_restart_answer | ICE Restart Answer | sdp |
| p2p_offer | P2P Offer | sdp |
| p2p_ice_candidate | P2P ICE候補 | candidate |
| ptt_granted | PTT許可 | - |
| ptt_denied | PTT拒否 | reason, speakerName |
| ptt_status | PTT状態通知 | state, speaker, speakerName |
| client_list | クライアント一覧 | clients[] |
| client_joined | クライアント参加 | clientId, displayName |
| client_left | クライアント離脱 | clientId |

---

## タイムアウト値一覧

| 項目 | 値 | 説明 |
|------|-----|------|
| ICE Gathering (メイン) | 3秒 | srflx候補取得後の待機 |
| ICE Gathering (P2P) | 2秒 | P2P用ICE収集 |
| ICE Restart (サーバー) | 5秒 | Offer待機タイムアウト |
| ICE Restart (クライアント) | 5秒 | 回復待機タイムアウト |
| P2P Cleanup | 10秒 | disconnected後のクリーンアップ |
| PTT Timeout | 5分 | 長時間送信防止 |
| WebSocket Heartbeat | 30秒 | 接続維持ping間隔 |

---

## Opusコーデック設定

```javascript
// SDP内のOpusパラメータ
stereo=0              // モノラル
sprop-stereo=0        // 受信側もモノラル
useinbandfec=1        // FEC有効（パケットロス対策）
maxaveragebitrate=24000  // 24kbps制限
// usedtx=1           // DTX無効（一部端末で問題発生）
```

---

## 関連ドキュメント

- [implementation-notes.md](implementation-notes.md) - 実装の詳細知見
- [bandwidth-analysis.md](bandwidth-analysis.md) - 通信量分析
