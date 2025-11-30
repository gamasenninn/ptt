import time
from pathlib import Path
from faster_whisper import WhisperModel
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# ========== 設定 ==========
RECORDINGS_DIR = Path(__file__).parent / "recordings"
MODEL_SIZE = "large-v3"
DEVICE = "cuda"
COMPUTE_TYPE = "float16"

# ========== Whisperモデル（グローバル） ==========
model = None

def get_model():
    global model
    if model is None:
        print(f"モデル読み込み中: {MODEL_SIZE} ({DEVICE}, {COMPUTE_TYPE})...")
        model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
        print("モデル読み込み完了")
    return model

def format_time(seconds):
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    milliseconds = int((seconds % 1) * 1000)
    return f"{int(hours):02d}:{int(minutes):02d}:{int(seconds):02d},{milliseconds:03d}"

def transcribe_to_srt(wav_path):
    """WAVファイルを文字起こししてSRTファイルを保存"""
    wav_path = Path(wav_path)
    srt_path = wav_path.with_suffix(".srt")

    if srt_path.exists():
        print(f"スキップ（SRT存在）: {wav_path.name}")
        return

    print(f"文字起こし開始: {wav_path.name}")

    m = get_model()
    segments, info = m.transcribe(
        str(wav_path),
        language="ja",
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=1000),
    )

    print(f"  言語: {info.language} (確率: {info.language_probability:.2f})")

    with open(srt_path, "w", encoding="utf-8") as f:
        for i, segment in enumerate(segments, start=1):
            text = segment.text.strip()
            print(f"  [{segment.start:.2f}s -> {segment.end:.2f}s] {text}")
            f.write(f"{i}\n")
            f.write(f"{format_time(segment.start)} --> {format_time(segment.end)}\n")
            f.write(f"{text}\n\n")

    print(f"保存完了: {srt_path.name}")

def scan_missing_srt():
    """起動時に*.wavをスキャンし、対応する*.srtがないものを処理"""
    if not RECORDINGS_DIR.exists():
        print(f"フォルダが存在しません: {RECORDINGS_DIR}")
        return

    wav_files = list(RECORDINGS_DIR.glob("*.wav"))
    missing = [f for f in wav_files if not f.with_suffix(".srt").exists()]

    if missing:
        print(f"未処理ファイル: {len(missing)}件")
        for wav_path in missing:
            transcribe_to_srt(wav_path)
    else:
        print("未処理ファイルなし")

class WavHandler(FileSystemEventHandler):
    """新規WAVファイル検出ハンドラー"""
    def on_created(self, event):
        if event.is_directory:
            return
        if event.src_path.endswith(".wav"):
            # ファイル書き込み完了を待つ
            time.sleep(1)
            transcribe_to_srt(event.src_path)

def main():
    print("=" * 50)
    print("  WAV → SRT 文字起こしサービス")
    print("=" * 50)
    print(f"  監視フォルダ: {RECORDINGS_DIR}")
    print(f"  モデル: {MODEL_SIZE}")
    print()

    # 初期スキャン
    print("[1] 初期スキャン")
    scan_missing_srt()
    print()

    # フォルダ監視開始
    print("[2] フォルダ監視開始")
    print("  Ctrl+C で終了")
    print()

    RECORDINGS_DIR.mkdir(exist_ok=True)

    event_handler = WavHandler()
    observer = Observer()
    observer.schedule(event_handler, str(RECORDINGS_DIR), recursive=False)
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        print("\n終了")

    observer.join()

if __name__ == "__main__":
    main()
