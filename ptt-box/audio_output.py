"""
音声出力スクリプト（デバイス指定対応・常駐モード）
stdin から連続OGG/Opusストリームを受け取り、指定デバイスに出力

常駐モード:
  server.jsから起動され、サーバー終了まで動作し続ける
  PTT間の無音時もプロセスは維持される

Usage:
  python audio_output.py [device_id_or_name]

Environment:
  SPEAKER_DEVICE_NAME - 出力デバイス名（部分一致検索、優先）
  SPEAKER_DEVICE_ID - 出力デバイスID (SPEAKER_DEVICE_NAMEが未設定時のフォールバック)
"""
import sys
import os
import subprocess
import threading
import queue
import numpy as np
import sounddevice as sd

SAMPLE_RATE = 48000
CHANNELS = 1
BLOCKSIZE = 480  # 10ms @ 48kHz（低遅延）

def log(msg):
    print(f"[audio_output] {msg}", file=sys.stderr, flush=True)

def find_device_by_name(name):
    """デバイス名で出力デバイスを検索（部分一致）。見つからなければNone。"""
    devices = sd.query_devices()
    for i, dev in enumerate(devices):
        if name in dev['name'] and dev['max_output_channels'] > 0:
            return i, dev['name']
    return None, None

def resolve_device():
    """コマンドライン引数 → SPEAKER_DEVICE_NAME → SPEAKER_DEVICE_ID の優先順でデバイスを決定"""
    arg = sys.argv[1] if len(sys.argv) > 1 else None

    # 引数が数値でない場合はデバイス名として扱う
    if arg and not arg.isdigit():
        device_id, device_name = find_device_by_name(arg)
        if device_id is not None:
            log(f"Device found by name '{arg}': id={device_id}, name={device_name}")
            return device_id, device_name
        log(f"WARNING: Device name '{arg}' not found, falling back to SPEAKER_DEVICE_ID")

    # 引数が数値の場合はそのまま使う
    if arg and arg.isdigit():
        device_id = int(arg)
        dev_info = sd.query_devices(device_id)
        log(f"Device by ID: id={device_id}, name={dev_info['name']}")
        return device_id, dev_info['name']

    # 環境変数 SPEAKER_DEVICE_NAME で検索
    env_name = os.environ.get('SPEAKER_DEVICE_NAME', '')
    if env_name:
        device_id, device_name = find_device_by_name(env_name)
        if device_id is not None:
            log(f"Device found by SPEAKER_DEVICE_NAME '{env_name}': id={device_id}, name={device_name}")
            return device_id, device_name
        log(f"WARNING: SPEAKER_DEVICE_NAME '{env_name}' not found, falling back to SPEAKER_DEVICE_ID")

    # フォールバック: SPEAKER_DEVICE_ID
    device_id = int(os.environ.get('SPEAKER_DEVICE_ID', 0))
    dev_info = sd.query_devices(device_id)
    log(f"Device by SPEAKER_DEVICE_ID: id={device_id}, name={dev_info['name']}")
    return device_id, dev_info['name']

DEVICE_ID, DEVICE_NAME = resolve_device()
log(f"Starting audio output to device {DEVICE_ID} ({DEVICE_NAME})")

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
