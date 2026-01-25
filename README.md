# PTT - WebRTC Push-To-Talk System

WebRTCベースの双方向PTT（Push-To-Talk）トランシーバーシステム。スマートフォンやPCからリアルタイム音声通信を行い、アナログ無線機とも連携可能。

## Features

- **WebRTCリアルタイム通信** - 低遅延の双方向音声通信
- **PWA対応** - スマートフォンにインストール可能
- **P2P音声配信** - サーバー経由で複数クライアントに音声配信
- **アナログ無線機連携** - シリアルリレーでPTT制御
- **VOX録音** - 音声検知による自動録音
- **文字起こし** - faster-whisperによる自動文字起こし
- **モバイル対応** - WiFi/4G/5G切替時の自動再接続

## System Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  スマホ/PC   │     │   Server    │     │  スマホ/PC   │
│  (PWA)      │     │  (Node.js)  │     │  (PWA)      │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │◄─── WebSocket ───►│◄─── WebSocket ───►│
       │◄─── WebRTC ──────►│◄─── P2P Audio ───►│
                           │
                    ┌──────┴──────┐
                    │   FFmpeg    │
                    │  (Mic/Spk)  │
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │ Serial Relay│
                    │ (PTT制御)   │
                    └─────────────┘
```

## Quick Start

### サーバー起動

```bash
cd ptt-box/stream_server
npm install
cp .env.example .env  # 設定ファイル作成
node server.js
```

ブラウザで `http://localhost:9320` にアクセス。

### Python環境 (文字起こし等)

```bash
# 依存関係インストール
uv sync

# 文字起こしサービス
uv run python ptt-box/transcriber.py
```

## Configuration

`.env` ファイルで設定:

```bash
# サーバー
HTTP_PORT=9320
STUN_SERVER=stun.l.google.com:19302
TURN_SERVER=your-turn-server.com
TURN_USERNAME=user
TURN_PASSWORD=pass

# 音声デバイス
MIC_DEVICE_NAME="マイク (USB PnP Audio Device)"
SPEAKER_DEVICE_NAME="スピーカー"
SERVER_MIC_MODE=always  # always|vox|off

# リレー制御 (アナログ無線機用)
ENABLE_RELAY=true
RELAY_PORT=COM3

# ダッシュボード
DASH_PASSWORD=admin
```

## Directory Structure

```
ptt-box/
├── stream_server/      # Node.js WebRTCサーバー
│   ├── server.js       # メインサーバー
│   └── logs/           # サーバーログ
├── stream_client/      # Webクライアント (PWA)
│   ├── index.html      # メインUI
│   ├── js/stream.js    # WebRTC/PTT
│   └── js/history.js   # 履歴管理
├── docs/               # 詳細ドキュメント
├── recordings/         # WAV/SRTファイル
├── transcriber.py      # 文字起こし (Whisper)
├── vox_ptt_record.py   # VOX録音
└── uploader.py         # FTPアップロード
```

## Usage

### Webトランシーバー

1. ブラウザで `http://[server]:9320` にアクセス
2. 「未接続」ボタンをタップして接続
3. PTTボタンを押しながら話す
4. ボタンを離すと送信終了

### 管理ダッシュボード

`http://[server]:9320/dash/` で接続状況の監視・管理が可能。

### 履歴タブ

録音された音声とSRT（文字起こし）の一覧表示・編集。

## Technical Details

### 音声コーデック

- **Opus** (24kbps mono)
- FEC有効（パケットロス対策）
- DTX無効（互換性のため）

### タイムアウト値

| 項目 | 値 |
|------|-----|
| ICE Restart | 5秒 |
| Offer待ち | 30秒 |
| P2P Cleanup | 10秒 |
| PTT Timeout | 5分 |
| WebSocket Heartbeat | 30秒 |

### モバイルネットワーク対応

WiFi→4G→5G等のネットワーク切替時、ICE Restartにより0.5-1秒で自動再接続。

## Development

```bash
# テスト実行
cd ptt-box/stream_server && npm test

# ログ確認
cat ptt-box/stream_server/logs/server-$(date +%Y-%m-%d).log
```

詳細は [CLAUDE.md](./CLAUDE.md) を参照。

## Documentation

- [CLAUDE.md](./CLAUDE.md) - 開発ガイド
- [docs/communication-sequence.md](./ptt-box/docs/communication-sequence.md) - 通信シーケンス図
- [docs/implementation-notes.md](./ptt-box/docs/implementation-notes.md) - 実装知見

## Tech Stack

- **Server**: Node.js, Express, WebSocket, werift (WebRTC)
- **Client**: PWA, Web Audio API, Service Worker
- **Audio**: FFmpeg, Opus codec
- **Transcription**: faster-whisper, ONNX Runtime
- **Legacy**: Python (VOX録音)

## License

MIT
