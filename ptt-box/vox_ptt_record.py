import sounddevice as sd
import numpy as np
import time
import wave
import threading
from datetime import datetime
from pathlib import Path

# ========== 設定 ==========
DEVICE_INDEX = 1          # USBマイク (MME)
THRESHOLD = 0.0020        # VOX閾値
SAMPLE_RATE = 44100
BLOCK_SIZE = 1024
HOLD_COUNT = 3            # 連続3回超えたらON
HOLD_TIME = 1.5           # PTT OFFまでの待ち時間
SAVE_DELAY = 10.0         # 最後のOFFから保存までの待ち時間
GAIN = 10.0               # 録音ゲイン
RECORDINGS_DIR = Path(__file__).parent / "recordings"

# ========== 状態変数 ==========
above_count = 0
is_active = False
last_voice_time = 0
recording_data = []
is_recording = False
record_start_time = None
last_ptt_off_time = None
save_timer = None

def get_volume(audio_data):
    return np.sqrt(np.mean(audio_data ** 2))

def save_recording():
    """録音データをWAVファイルに保存"""
    global recording_data, record_start_time, save_timer, is_recording
    
    if len(recording_data) == 0:
        return
    
    audio_data = np.concatenate(recording_data)
    audio_data = audio_data * GAIN
    audio_data = np.clip(audio_data, -1.0, 1.0)
    
    RECORDINGS_DIR.mkdir(exist_ok=True)
    filename = RECORDINGS_DIR / record_start_time.strftime("rec_%Y%m%d_%H%M%S.wav")
    
    with wave.open(str(filename), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        audio_int16 = (audio_data * 32767).astype(np.int16)
        wf.writeframes(audio_int16.tobytes())
    
    duration = len(audio_data) / SAMPLE_RATE
    print(f"    💾 保存完了: {filename.name} ({duration:.1f}秒)")
    
    # リセット
    recording_data = []
    record_start_time = None
    save_timer = None
    is_recording = False

def schedule_save():
    """10秒後に保存をスケジュール"""
    global save_timer
    
    # 既存のタイマーがあればキャンセル
    if save_timer is not None:
        save_timer.cancel()
    
    save_timer = threading.Timer(SAVE_DELAY, save_recording)
    save_timer.start()
    print(f"    ⏱️ {SAVE_DELAY}秒後に保存予定...")

def cancel_save():
    """保存タイマーをキャンセル"""
    global save_timer
    
    if save_timer is not None:
        save_timer.cancel()
        save_timer = None
        print(f"    ⏱️ 保存キャンセル（会話継続）")

def audio_callback(indata, frames, time_info, status):
    global above_count, is_active, last_voice_time
    global recording_data, is_recording, record_start_time
    
    volume = get_volume(indata)
    current_time = time.time()
    
    if volume > THRESHOLD:
        above_count += 1
        last_voice_time = current_time
    else:
        above_count = 0
    
    # ===== PTT ON判定 =====
    if above_count >= HOLD_COUNT and not is_active:
        is_active = True
        
        # 新規セッション開始 or 継続
        if not is_recording:
            is_recording = True
            recording_data = []
            record_start_time = datetime.now()
            print(f">>> PTT ON  (音量: {volume:.4f}) - 録音開始 🎙️")
        else:
            # 保存タイマーをキャンセルして継続
            cancel_save()
            print(f">>> PTT ON  (音量: {volume:.4f}) - 録音継続 🎙️")
    
    # ===== 録音中はデータを蓄積 =====
    if is_recording:
        recording_data.append(indata.copy())
    
    # ===== PTT OFF判定 =====
    if is_active and (current_time - last_voice_time) > HOLD_TIME:
        is_active = False
        print(f"<<< PTT OFF")
        
        # 10秒後に保存をスケジュール
        schedule_save()

def main():
    print("=" * 50)
    print("  VOX + PTT + 録音 テストプログラム")
    print("=" * 50)
    print(f"  デバイス: {DEVICE_INDEX}")
    print(f"  閾値: {THRESHOLD}")
    print(f"  PTTホールド: {HOLD_TIME}秒")
    print(f"  保存待ち: {SAVE_DELAY}秒")
    print(f"  録音ゲイン: x{GAIN}")
    print()
    print("  喋ると録音開始")
    print("  最後のPTT OFFから10秒後にファイル保存")
    print("  Ctrl+C で終了")
    print("=" * 50)
    print()
    
    try:
        with sd.InputStream(callback=audio_callback,
                            device=DEVICE_INDEX,
                            samplerate=SAMPLE_RATE,
                            blocksize=BLOCK_SIZE,
                            channels=1,
                            dtype=np.float32):
            while True:
                sd.sleep(100)
    except KeyboardInterrupt:
        # 未保存データがあれば保存
        if len(recording_data) > 0:
            print("\n未保存データを保存中...")
            if save_timer is not None:
                save_timer.cancel()
            save_recording()
        print("\n終了しました")
    except Exception as e:
        print(f"エラー: {e}")
        input("Enterで終了...")

if __name__ == "__main__":
    main()
