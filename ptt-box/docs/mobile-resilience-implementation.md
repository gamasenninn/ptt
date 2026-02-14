# モバイルネットワーク耐性向上の実装記録

## 概要

feature/mobile-resilience ブランチで実装した、モバイルネットワーク切替時の接続回復機能の詳細記録。

### 背景

スマートフォンでWiFi ↔ モバイルデータ（4G/5G）を切り替えた際、WebRTC接続が切断され復旧に時間がかかる、または復旧しない問題があった。

### 目標

- ネットワーク切替時のICE restart成功率向上
- 復旧時間の短縮（目標: 1秒以内）
- P2P接続の自動再確立

---

## コミット履歴と実装内容

### 1. ba3de37 - 基本的なタイムアウト調整

**変更内容:**
- ジッターバッファ: 100ms → 200ms（セルタワーハンドオフ対策）
- ICE restartタイムアウト: 5秒 → 10秒
- P2Pクリーンアップタイムアウト: 10秒 → 15秒

**目的:** 基本的な耐性向上のベースライン設定

---

### 2. ed51127 - ICE restart高速化（Early Proceed）

**変更内容:**
- 初回接続で使用しているearly proceed最適化をICE restartにも適用
- srflx/relay候補発見後、500msで次のステップへ進む

**効果:** ICE restart時間 9秒 → 5-6秒に短縮

---

### 3. e2bf4bc / 660eb59 - RTPドリフト測定の修正

**問題:** フレーム到着間隔ベースのドリフト測定が誤った値を表示

**変更内容:**
- RTPタイムスタンプベースのドリフト測定に変更
- 誤警告の削除

**補足:** WebRTCのジッターバッファが補正するため、このドリフトは音質に影響しない

---

### 4. 1f6666f - ICE restart診断ログ追加

**追加ログ:**

| 場所 | ログ内容 |
|------|----------|
| サーバー | ICE候補追加（タイプ別）、エラー、接続状態変化 |
| クライアント | ICE restart各ステップの状態、SDP内の候補タイプ |

**目的:** ICE restart失敗の原因特定

---

### 5. 7fa5d80 - ICE候補なしSDP対策

**問題:** restartIce()後、Chrome Mobileが即座にiceGatheringState=completeを報告するが候補が0個

**修正:**
- SDP内に候補がない場合、追加で2秒待機
- Trickle ICEで候補が後から到着するのを待つ

---

### 6. 83cd7bd - リモートログ収集機能

**追加機能:**
- クライアント側: 500行の循環ログバッファ
- UI: デバッグパネルに「ログ送信」ボタン
- サーバー側: `logs/client-{name}-{timestamp}.log` に保存

**目的:** モバイル端末からのデバッグログ収集を簡易化

---

### 7. 2d7705b - ICE restartリトライ機構

**変更内容:**
- タイムアウト: 10秒 → 3秒（最大3回リトライ）
- 2秒時点での中間チェック追加
- 詳細な診断ログ

**効果:** 典型的な復旧時間 0.5-0.7秒に改善

---

### 8. 2110685 - P2P再接続機能

**問題:** ICE restart成功後もP2P接続が回復せず、10秒後にfailure

**追加機能:**

```
[クライアント]                    [サーバー]
ICE restart成功
    ↓
reconnectP2PAfterIceRestart()
    ↓
request_p2p_reconnect  ────→  handleP2PReconnectRequest()
                                   ↓
                              - iceRestartTimer クリア
                              - cleanupTimer クリア
                              - P2P再作成
    ↓
client_list受信 → P2P確立
```

**追加修正:**
- 同名接続のクリーンアップ（ゴースト接続対策）
- stale P2P接続の自動再作成

---

### 9. 79e436c - 不要なICE restart防止

**問題:** 既にconnected状態なのにICE restartが発生し、無限ループ

**修正:**
- クライアント: connected状態ならサーバーからのrequest_ice_restartを無視
- クライアント: タイムアウト時にconnected状態なら成功扱い
- サーバー: disconnected検知時にrequest_ice_restartを送信（非対称状態対策）

---

### 10. 5a87c81 - ICE restart成功後のクールダウン

**問題:** ICE restart成功後、一時的なdisconnected状態で新しいタイマーが設定され、10秒後にWebSocket切断

**根本原因:**
```
handleP2PReconnectRequest()
    ├─ iceRestartTimer クリア
    ├─ iceRestartInProgress = false  ← ここで解除
    └─ createP2PToClient()
           ↓
client.pc.connectionState → 'disconnected' (一時的)
           ↓
onconnectionstatechange 発火
    ├─ !iceRestartTimer → true
    ├─ !iceRestartInProgress → true
    └─ 新しいタイマー設定 → 10秒後に切断
```

**修正:**
```javascript
// handleP2PReconnectRequest()
client.iceRestartSuccessTime = Date.now();

// onconnectionstatechange
const cooldownMs = 10000;
const timeSinceSuccess = client.iceRestartSuccessTime
    ? Date.now() - client.iceRestartSuccessTime
    : Infinity;

if (timeSinceSuccess > cooldownMs) {
    // タイマー設定
} else {
    log('ICE restart cooldown active');
}
```

---

## 最終的なICE restart フロー

```
[ネットワーク切替発生]
        ↓
[クライアント]              [サーバー]
ICE: disconnected
Connection: disconnected
        ↓
attemptIceRestart()
(attempt 1/3, timeout 3秒)
        ↓
restartIce() → Offer作成
        ↓
ice_restart_offer ─────→ handleIceRestartOffer()
                              ↓
                         Answer作成・送信
                              ↓
←───── ice_restart_answer
        ↓
setRemoteDescription()
        ↓
ICE: connected (0.2-0.5秒)
Connection: connected
        ↓
ICE restart successful!
        ↓
reconnectP2PAfterIceRestart()
        ↓
request_p2p_reconnect ───→ handleP2PReconnectRequest()
                              ├─ タイマークリア
                              ├─ クールダウン設定
                              └─ P2P再作成
        ↓
←───────── client_list
        ↓
P2P connections established
        ↓
[通信復旧完了] (総所要時間: 1-3秒)
```

---

## 検証結果

### テスト条件
- 端末: Android 10, Chrome 145
- ネットワーク: WiFi ↔ 4G/5G 切替

### 結果

| 項目 | 修正前 | 修正後 |
|------|--------|--------|
| ICE restart成功率 | 約30% | 約90% |
| 復旧時間 | 5-10秒 or 失敗 | 0.5-3秒 |
| P2P再接続 | 失敗 | 自動成功 |
| 不要な切断 | 頻発 | なし |

### 残存課題
- WebSocket 1006 (ネットワーク切断) は防止不可能
  - これはネットワーク自体の問題であり、フルリコネクトで対応
- WiFi有効時は切替が頻繁に発生する場合あり
  - WiFi無効（モバイルデータのみ）では安定

---

## ファイル変更一覧

| ファイル | 主な変更 |
|---------|----------|
| `stream_server/server.js` | ICE restart処理、タイマー管理、P2P再接続ハンドラ |
| `stream_client/js/stream.js` | ICE restartリトライ、P2P再接続、ログ収集 |
| `stream_client/index.html` | ログ送信ボタン |

---

## 参考: タイムアウト値一覧

| 項目 | 値 | 説明 |
|------|-----|------|
| ICE Restart Timeout | 3秒 | 1回あたりのタイムアウト |
| ICE Restart Max Attempts | 3回 | 最大リトライ回数 |
| ICE Restart Cooldown | 10秒 | 成功後の新タイマー抑制期間 |
| P2P Cleanup Timeout | 15秒 | disconnected後のクリーンアップ待機 |
| Jitter Buffer | 200ms | 再生遅延バッファ |

---

*作成日: 2026-02-14*
*ブランチ: feature/mobile-resilience*
