"""
音声出力スクリプト（デバイス指定対応・常駐モード）
stdin から連続OGG/Opusストリームを受け取り、指定デバイスに出力

常駐モード:
  server.jsから起動され、サーバー終了まで動作し続ける
  PTT間の無音時もプロセスは維持される

Usage:
  python audio_output.py [device_id]

Environment:
  SPEAKER_DEVICE_ID - 出力デバイスID (コマンドライン引数が優先)
"""
import sys
import os
import subprocess
import threading
import queue
import numpy as np
import sounddevice as sd

# 設定
DEVICE_ID = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('SPEAKER_DEVICE_ID', 0))
SAMPLE_RATE = 48000
CHANNELS = 1
BLOCKSIZE = 480  # 10ms @ 48kHz（低遅延）

def log(msg):
    print(f"[audio_output] {msg}", file=sys.stderr, flush=True)

log(f"Starting audio output to device {DEVICE_ID}")

# 音声データキュー（小さく = 低遅延）
audio_queue = queue.Queue(maxsize=5)  # 5 * 10ms = 50ms max

def audio_callback(outdata, frames, time, status):
    """sounddevice コールバック - キューからデータを取得して出力"""
    if status:
        log(f"Status: {status}")

    try:
        data = audio_queue.get_nowait()
        if len(data) < len(outdata):
            outdata[:len(data)] = data.reshape(-1, 1)
            outdata[len(data):] = 0
        else:
            outdata[:] = data[:len(outdata)].reshape(-1, 1)
    except queue.Empty:
        outdata.fill(0)

def decode_and_queue():
    """ffmpeg でデコードしてキューに追加"""
    # ffmpeg: stdin(OGG/Opus) → stdout(raw PCM)
    ffmpeg = subprocess.Popen([
        'ffmpeg',
        '-hide_banner',
        '-loglevel', 'error',
        '-fflags', 'nobuffer',      # 入力バッファ無効
        '-flags', 'low_delay',      # 低遅延モード
        '-f', 'ogg',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', str(SAMPLE_RATE),
        '-ac', str(CHANNELS),
        'pipe:1'
    ], stdin=sys.stdin.buffer, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    bytes_per_block = BLOCKSIZE * 2  # 16-bit = 2 bytes per sample

    while True:
        data = ffmpeg.stdout.read(bytes_per_block)
        if not data:
            break

        # bytes → float32 に変換
        samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0

        try:
            audio_queue.put(samples, timeout=0.1)
        except queue.Full:
            pass  # キューが満杯なら破棄（遅延防止）

    ffmpeg.wait()
    log("Decode finished")

# デコードスレッド開始
decode_thread = threading.Thread(target=decode_and_queue, daemon=True)
decode_thread.start()

# 音声出力ストリーム開始
try:
    with sd.OutputStream(
        device=DEVICE_ID,
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        blocksize=BLOCKSIZE,
        dtype=np.float32,
        callback=audio_callback
    ):
        log(f"Audio stream started (device={DEVICE_ID}, rate={SAMPLE_RATE}, blocksize={BLOCKSIZE})")
        decode_thread.join()  # デコード完了まで待機

        # キューが空になるまで少し待つ
        import time
        while not audio_queue.empty():
            time.sleep(0.05)
        time.sleep(0.1)  # 最後のバッファ再生待ち

except Exception as e:
    log(f"Error: {e}")
    sys.exit(1)

log("Audio output finished")
