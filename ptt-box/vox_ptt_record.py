import os
import sounddevice as sd
import numpy as np
import time
import wave
import threading
import requests
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

# ハートビート設定
HEARTBEAT_INTERVAL = 30  # 秒
heartbeat_thread = None
heartbeat_stop_event = threading.Event()

# ========== 環境変数読み込み ==========
load_dotenv()

# ========== 設定 ==========
DEVICE_INDEX = int(os.environ.get("VOX_DEVICE_INDEX", "1"))
THRESHOLD = float(os.environ.get("VOX_THRESHOLD", "0.0020"))
SAMPLE_RATE = int(os.environ.get("VOX_SAMPLE_RATE", "44100"))
BLOCK_SIZE = int(os.environ.get("VOX_BLOCK_SIZE", "1024"))
HOLD_COUNT = int(os.environ.get("VOX_HOLD_COUNT", "3"))
HOLD_TIME = float(os.environ.get("VOX_HOLD_TIME", "1.5"))
SAVE_DELAY = float(os.environ.get("VOX_SAVE_DELAY", "10.0"))
GAIN = float(os.environ.get("VOX_GAIN", "10.0"))
RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", Path(__file__).parent / "recordings"))
STREAM_SERVER_URL = os.environ.get("STREAM_SERVER_URL", "http://localhost:9320")

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

def heartbeat_loop():
    """定期的にハートビートを送信"""
    while not heartbeat_stop_event.is_set():
        try:
            requests.post(
                f"{STREAM_SERVER_URL}/api/health/beat",
                json={"service": "vox"},
                timeout=5
            )
        except Exception as e:
            print(f"    ⚠️ [Heartbeat] 送信失敗: {e}")

        # 30秒待機（stop_eventで中断可能）
        heartbeat_stop_event.wait(HEARTBEAT_INTERVAL)


def start_heartbeat():
    """ハートビートスレッドを開始"""
    global heartbeat_thread
    heartbeat_stop_event.clear()
    heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    heartbeat_thread.start()
    print("  [Heartbeat] 開始")


def stop_heartbeat():
    """ハートビートスレッドを停止"""
    heartbeat_stop_event.set()
    if heartbeat_thread:
        heartbeat_thread.join(timeout=2)


def notify_vox_on():
    """サーバーにVOX ON通知"""
    try:
        requests.post(f"{STREAM_SERVER_URL}/api/vox/on", timeout=1)
    except Exception as e:
        print(f"    ⚠️ VOX ON通知エラー: {e}")

def notify_vox_off():
    """サーバーにVOX OFF通知"""
    try:
        requests.post(f"{STREAM_SERVER_URL}/api/vox/off", timeout=1)
    except Exception as e:
        print(f"    ⚠️ VOX OFF通知エラー: {e}")

def save_recording():
    """録音データをWAVファイルに保存"""
    global recording_data, record_start_time, save_timer, is_recording

    if len(recording_data) == 0:
        return

    audio_data = np.concatenate(recording_data)

    # 末尾の無音部分（SAVE_DELAY秒分）をカット
    cut_samples = int(SAVE_DELAY * SAMPLE_RATE)
    if len(audio_data) > cut_samples:
        audio_data = audio_data[:-cut_samples]

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
        notify_vox_on()  # サーバーに通知

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
        notify_vox_off()  # サーバーに通知
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

    # ハートビート開始
    start_heartbeat()

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
        stop_heartbeat()
        print("\n終了しました")
    except Exception as e:
        stop_heartbeat()
        print(f"エラー: {e}")
        input("Enterで終了...")

if __name__ == "__main__":
    main()
