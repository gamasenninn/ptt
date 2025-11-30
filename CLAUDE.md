# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VOX（Voice Operated eXchange）によるPTT（Push-To-Talk）自動制御ツール。マイク入力の音量を監視し、音声検出時に自動でPTTをON/OFFする。

## Commands

```bash
# Install dependencies
uv sync

# List audio devices
uv run python ptt-box/list_devices.py

# Run VOX detection (PTT ON/OFF display only)
uv run python ptt-box/vox_detect.py

# Run VOX + recording (saves WAV files)
uv run python ptt-box/vox_ptt_record.py
```

## Architecture

uv workspaceによるPythonモノレポ構成。

- **`ptt/`**: ルートパッケージ
- **`ptt-box/`**: VOX/PTT機能の実装
  - `list_devices.py`: オーディオデバイス一覧
  - `vox_detect.py`: VOX検出のみ
  - `vox_ptt_record.py`: VOX + 録音（WAV保存）

## Key Parameters (vox_ptt_record.py)

- `DEVICE_INDEX`: 使用するマイクデバイス番号
- `THRESHOLD`: 音量閾値（RMS）
- `HOLD_COUNT`: ON判定に必要な連続検出回数
- `HOLD_TIME`: 無音後OFFまでの待ち時間
- `SAVE_DELAY`: 最後のOFFからWAV保存までの待ち時間
- `GAIN`: 録音ゲイン
