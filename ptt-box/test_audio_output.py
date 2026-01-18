"""
音声出力デバイス指定テスト
Usage: uv run python ptt-box/test_audio_output.py [device_id]
"""
import sys
import numpy as np
import sounddevice as sd

# 出力デバイス一覧表示
print("=== 出力デバイス一覧 ===")
for i, dev in enumerate(sd.query_devices()):
    if dev['max_output_channels'] > 0:
        marker = ""
        if "USB PnP Audio Device" in dev['name']:
            marker = " <-- USB Speaker"
        print(f"  {i:2d}: {dev['name']}{marker}")

# デバイスID取得（引数またはデフォルト）
if len(sys.argv) > 1:
    DEVICE_INDEX = int(sys.argv[1])
else:
    DEVICE_INDEX = 20  # デフォルト: USB PnP Audio Device (WASAPI)

SAMPLE_RATE = 48000
DURATION = 2  # 秒
FREQUENCY = 440  # Hz

print(f"\n=== テスト設定 ===")
print(f"デバイスID: {DEVICE_INDEX}")
print(f"サンプルレート: {SAMPLE_RATE} Hz")
print(f"周波数: {FREQUENCY} Hz")
print(f"長さ: {DURATION} 秒")

# トーン生成
t = np.linspace(0, DURATION, int(SAMPLE_RATE * DURATION), dtype=np.float32)
tone = 0.3 * np.sin(2 * np.pi * FREQUENCY * t)

print(f"\nデバイス {DEVICE_INDEX} に出力中...")
try:
    sd.play(tone, samplerate=SAMPLE_RATE, device=DEVICE_INDEX, blocking=True)
    print("完了!")
except Exception as e:
    print(f"エラー: {e}")
