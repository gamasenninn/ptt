# ptt-box/

PTTシステムのメイン実装ディレクトリ。

詳細なドキュメントは [../README.md](../README.md) および [../CLAUDE.md](../CLAUDE.md) を参照。

## ディレクトリ構成

```
stream_server/   - Node.js WebRTCサーバー
stream_client/   - PWA Webクライアント
recordings/      - WAV/SRTファイル保存先
docs/            - 詳細ドキュメント（通信シーケンス図等）
*.py             - Python サービス（VOX録音、文字起こし）
```

## クイックスタート

```bash
# サーバー起動
cd stream_server && npm install && node server.js

# ブラウザでアクセス
open http://localhost:9320
```
