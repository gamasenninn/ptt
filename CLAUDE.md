# CLAUDE.md

Claude Code向けのプロジェクトガイダンス。

## Project Overview

WebRTCベースの双方向PTT（Push-To-Talk）トランシーバーシステム。スマートフォンやPCから音声通信を行い、アナログ無線機とも連携可能。VOX（Voice Operated eXchange）による自動録音と文字起こし機能も統合。

### 技術スタック

| レイヤー | 技術 |
|---------|------|
| サーバー | Node.js, Express, WebSocket, werift (WebRTC) |
| クライアント | PWA (HTML/CSS/JS), Web Audio API, Service Worker |
| 音声処理 | FFmpeg, Opus codec (24kbps mono) |
| 文字起こし | faster-whisper (large-v3), ONNX Runtime |
| その他 | Python (VOX/transcriber) |

---

## Quick Start

```bash
# サーバー起動
cd ptt-box/stream_server
npm install
node server.js

# 開発環境（Python依存関係）
uv sync

# 文字起こしサービス
uv run python ptt-box/transcriber.py

# テスト実行
cd ptt-box/stream_server && npm test
```

---

## Architecture

### ディレクトリ構成

```
ptt-box/
├── stream_server/      # Node.js WebRTCサーバー (メイン)
│   ├── server.js       # Express + WebSocket + WebRTC
│   ├── logs/           # サーバーログ (日付ローテーション)
│   └── package.json
├── stream_client/      # Webクライアント (PWA)
│   ├── index.html      # メインUI (タブ構成)
│   ├── js/stream.js    # WebRTC/PTT コア
│   ├── js/history.js   # SRT履歴・編集
│   ├── sw.js           # Service Worker
│   └── dash/           # 管理ダッシュボード
├── docs/               # 詳細ドキュメント
├── recordings/         # WAV/SRTファイル保存先
└── *.py                # Python サービス群
```

### 通信フロー

```
クライアント ←──WebSocket──→ サーバー ←──WebSocket──→ クライアント
     │                          │                          │
     └────── WebRTC (音声) ─────┘────── P2P (音声配信) ────┘
                                │
                          FFmpeg (マイク入力)
                                │
                          シリアルリレー (PTT制御)
```

### 主要クラス (server.js)

| クラス | 責務 |
|--------|------|
| `StreamServer` | メインサーバー、WebSocket/WebRTC管理 |
| `PttManager` | PTT状態管理、排他制御 |
| `RelayManager` | シリアルリレー制御 (COM port) |
| `ClientConnection` | クライアント接続情報 |

---

## Configuration (.env)

環境変数は用途別に2つのファイルで管理:

| ファイル | 用途 | テンプレート |
|---------|------|-------------|
| `ptt-box/.env` | Python サービス | `.env.example` |
| `ptt-box/stream_server/.env` | Node.js サーバー | `.env.example` |

### Node.js (stream_server/.env)

```bash
# サーバー基本
HTTP_PORT=9320
STUN_SERVER=stun:stun.l.google.com:19302

# 音声デバイス
MIC_DEVICE=マイク (USB PnP Audio Device)
USE_PYTHON_AUDIO=false  # true: audio_output.py / false: ffplay
SPEAKER_DEVICE_ID=0     # audio_output.py用

# リレー制御
ENABLE_RELAY=true
RELAY_PORT=COM3

# ダッシュボード
DASH_PASSWORD=admin
```

### Python (ptt-box/.env)

```bash
# VOX録音
VOX_DEVICE_INDEX=1
VOX_THRESHOLD=0.0020
VOX_HOLD_TIME=1.5

# 文字起こし
WHISPER_MODEL_SIZE=large-v3
WHISPER_DEVICE=cuda
WHISPER_COMPUTE_TYPE=float16

# 共通
RECORDINGS_DIR=./recordings
STREAM_SERVER_URL=http://localhost:9320
```

---

## Development Guidelines

### ログ重視デバッグ

問題が発生したら**まずログを分析**する。

```bash
# 今日のログ確認
cat ptt-box/stream_server/logs/server-$(date +%Y-%m-%d).log

# エラー検索
grep -i "error\|warn\|fail" logs/server-*.log

# 接続問題
grep "timeout\|no pong\|disconnected" logs/server-*.log

# Monitor ログ（5分間隔）
grep "\[Monitor\]" logs/server-*.log
```

**診断ログパターン:**

| ログ | 意味 |
|------|------|
| `[Audio] packets=N, sent to X/Y clients` | 音声送信状況 (5分間隔) |
| `[Monitor] uptime=Nmin, clients=X, p2p=Y` | サーバー状態 |
| `ICE restart offer (attempt N/5)` | 再接続試行 |
| `no pong response` | クライアント応答なし |

### 段階的改善

1. **小さな修正を積み重ねる** - 大きな変更は避ける
2. **本番テストで検証** - サーバー再起動後に動作確認
3. **実機テスト重視** - モバイルネットワーク切替、WiFi→4G→5G等
4. **ログで効果を確認** - 修正前後でログを比較

### コミットスタイル

```bash
# 機能追加
feat: add diagnostic logging for connection state

# バグ修正
fix: prevent race condition in WebRTC event handlers

# 日本語コメントOK、コミットメッセージは英語
```

---

## Known Issues & Solutions

### ICE Restart (モバイルネットワーク切替)

モバイル端末がWiFi→4Gに切り替わると接続が切断される。ICE Restartで0.5-1秒で回復を試みる。

**対策:**
- 最大試行回数制限 (`MAX_ICE_RESTART_ATTEMPTS = 5`)
- Answer送信後も新しいタイムアウトタイマーを設定
- 試行回数超過で接続を閉じる

### 古い接続のクリーンアップ

クライアントが再接続すると古い接続が残ることがある。

**対策:**
- Offer待ちタイムアウト (`OFFER_TIMEOUT = 30000`)
- P2P切断後のクリーンアップタイマー (10秒)
- handleDisconnectで全タイマーをクリア

### エコー防止

WebクライアントがPTT送信中、サーバーマイクの音声を全ブロック。

```javascript
// WebクライアントがPTT中は、サーバーマイク音声を一切送信しない
if (currentSpeaker && currentSpeaker !== serverClientId && currentSpeaker !== 'external') {
    return;  // エコーループ防止
}
```

### レースコンディション防止

古い接続のイベントが新しい接続に干渉する問題。

```javascript
const thisPC = pc;  // ローカル参照を保存
pc.onconnectionstatechange = () => {
    if (pc !== thisPC) return;  // 古い接続のイベントを無視
    // ...
};
```

---

## タイムアウト値一覧

| 項目 | 値 | 説明 |
|------|-----|------|
| ICE Gathering (メイン) | 3秒 | srflx候補取得後の待機 |
| ICE Gathering (P2P) | 2秒 | P2P用ICE収集 |
| ICE Restart | 5秒 | Offer/Answer後の回復待機 |
| Offer待ち | 30秒 | WebSocket接続後のOffer待機 |
| P2P Cleanup | 10秒 | disconnected後のクリーンアップ |
| PTT Timeout | 5分 | 長時間送信防止 |
| WebSocket Heartbeat | 30秒 | 接続維持ping間隔 |

---

## Opus設定

```javascript
stereo=0              // モノラル
sprop-stereo=0        // 受信側もモノラル
useinbandfec=1        // FEC有効（パケットロス対策）
maxaveragebitrate=24000  // 24kbps制限
// usedtx=1 は無効（一部端末で問題発生）
```

---

## Testing

```bash
# Node.js (Jest)
cd ptt-box/stream_server
npm test

# 実機テスト
# 1. スマホでWebトランシーバーに接続
# 2. WiFi→4G切替を行う
# 3. 接続が自動回復することを確認
# 4. ダッシュボードで古い接続が残っていないか確認
```

---

## Monitoring

### health-check レポート

```bash
# ログディレクトリに保存
ptt-box/stream_server/logs/health-check-YYYY-MM-DD.md
```

### Monitor ログの読み方

```
[Monitor] uptime=700min, clients=2, p2p=2, push=6, heap=30MB, rtp=55802/1815177600
[Monitor] P2P: ono_pc:connected, Hiro:connected
```

| 項目 | 意味 |
|------|------|
| uptime | サーバー稼働時間 |
| clients | 接続クライアント数 |
| p2p | P2P接続数 (clientsと一致すべき) |
| push | Push通知登録数 |
| heap | メモリ使用量 (30-40MB程度が正常) |
| rtp | RTPカウンター/累計バイト |

---

## Documentation

詳細なドキュメントは `ptt-box/docs/` を参照:

- **communication-sequence.md** - 通信シーケンス図、メッセージ一覧
- **implementation-notes.md** - 実装詳細、知見集
- **bandwidth-analysis.md** - 帯域分析
- **CODE_REVIEW.md** - コードレビューガイドライン

---

## Python Services (レガシー/補助)

VOX録音と文字起こしのパイプライン:

```bash
# VOX録音
uv run python ptt-box/vox_ptt_record.py

# 文字起こし (faster-whisper)
uv run python ptt-box/transcriber.py

# デバイス一覧
uv run python ptt-box/list_devices.py
```

---

## セキュリティ

- ディレクトリトラバーサル防止 (`path.basename()` でサニタイズ)
- ダッシュボードはパスワード認証
- WebSocket接続は30秒間隔でping/pong
- HTTPS/WSS推奨 (本番環境)
