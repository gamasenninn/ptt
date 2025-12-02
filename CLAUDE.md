# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VOX（Voice Operated eXchange）によるPTT（Push-To-Talk）自動制御と文字起こしシステム。マイク入力→録音→文字起こし→Webビューアのパイプラインを提供。

## Commands

```bash
# Install Python dependencies
uv sync

# List audio devices
uv run python ptt-box/list_devices.py

# Run VOX detection (PTT ON/OFF display only)
uv run python ptt-box/vox_detect.py

# Run VOX + recording (saves WAV files to recordings/)
uv run python ptt-box/vox_ptt_record.py

# Run transcription service (WAV → SRT)
uv run python ptt-box/transcriber.py

# Run FTP upload service
uv run python ptt-box/uploader.py

# Run PHP tests
cd ptt-box/web && php vendor/bin/phpunit tests/
```

## Architecture

uv workspaceによるPythonモノレポ + PHP Webビューア構成。

### Python Services (ptt-box/)

3つの独立したサービスがパイプラインを構成：

1. **vox_ptt_record.py**: マイク音声監視 → `recordings/*.wav` 保存
2. **transcriber.py**: WAVファイル監視 → faster-whisper（large-v3）で文字起こし → `recordings/*.srt` 保存
3. **uploader.py**: WAV/SRTファイル監視 → FTPアップロード（.updoneマーカーで管理）

各サービスはwatchdogでフォルダ監視し、ファイル追加時に自動処理。

### Web Viewer (ptt-box/web/)

PHP製のSRTビューア/エディタ。

- **api.php**: REST API（list/get/save）
- **audio.php**: WAVファイル配信
- **src/SrtService.php**: ビジネスロジック（SRTパース、プレビュー生成）
- **src/SrtRepository.php**: ファイルI/O（バックアップ付き保存）
- **js/app.js**: クライアントUI（ファイル一覧、編集モーダル、音声再生）

## Key Parameters

### vox_ptt_record.py
- `DEVICE_INDEX`: マイクデバイス番号
- `THRESHOLD`: 音量閾値（RMS）
- `HOLD_TIME`: 無音後OFFまでの待ち時間
- `SAVE_DELAY`: 最後のOFFからWAV保存までの待ち時間
- `GAIN`: 録音ゲイン

### uploader.py（環境変数 - .envファイル）
- `FTP_SERVER_URL`, `FTP_USER_ID`, `FTP_PASSWORD`
- `REMOTE_FILE_DIR`: リモートディレクトリ
- `MAX_REMOTE_FILES`: 最大ファイル数（古いファイル自動削除）
