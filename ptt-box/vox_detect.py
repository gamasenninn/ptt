import sounddevice as sd
import numpy as np
import time

DEVICE_INDEX = 1
THRESHOLD = 0.0020
SAMPLE_RATE = 44100
BLOCK_SIZE = 1024
HOLD_COUNT = 3       # 連続3回超えたらON
HOLD_TIME = 1.0     # OFFまで0.5秒待つ

above_count = 0
is_active = False
last_voice_time = 0

def get_volume(audio_data):
    return np.sqrt(np.mean(audio_data ** 2))

def audio_callback(indata, frames, time_info, status):
    global above_count, is_active, last_voice_time
    volume = get_volume(indata)
    current_time = time.time()
    
    if volume > THRESHOLD:
        above_count += 1
        last_voice_time = current_time
    else:
        above_count = 0
    
    # 連続でHOLD_COUNT回超えたらON
    if above_count >= HOLD_COUNT and not is_active:
        is_active = True
        print(f">>> PTT ON  (音量: {volume:.4f})")
    
    # ホールドタイム経過後にOFF
    if is_active and (current_time - last_voice_time) > HOLD_TIME:
        is_active = False
        print(f"<<< PTT OFF")

try:
    with sd.InputStream(callback=audio_callback,
                        device=DEVICE_INDEX,
                        samplerate=SAMPLE_RATE,
                        blocksize=BLOCK_SIZE,
                        channels=1):
        print(f"VOX検出中")
        print(f"  閾値: {THRESHOLD}")
        print(f"  ON判定: 連続{HOLD_COUNT}回")
        print(f"  ホールド: {HOLD_TIME}秒")
        print("Ctrl+Cで終了")
        print()
        while True:
            sd.sleep(100)
except KeyboardInterrupt:
    print("\n終了")
except Exception as e:
    print(f"エラー: {e}")
    input("Enterで終了...")