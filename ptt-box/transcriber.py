import os
import time
import json
import asyncio
import threading
from pathlib import Path
from faster_whisper import WhisperModel
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from dotenv import load_dotenv

# ========== 環境変数読み込み ==========
load_dotenv()

# ========== 設定 ==========
RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", Path(__file__).parent / "recordings"))
MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")

# AI Assistant 設定 (後方互換: 旧WS_*変数もサポート)
ENABLE_AI_ASSISTANT = os.environ.get("ENABLE_AI_ASSISTANT", "true").lower() == "true"
ASSISTANT_HOST = os.environ.get("ASSISTANT_HOST", os.environ.get("ASSISTANT_WS_HOST", "localhost"))
ASSISTANT_PORT = int(os.environ.get("ASSISTANT_PORT", os.environ.get("ASSISTANT_WS_PORT", "9321")))

# ========== Whisperモデル（グローバル） ==========
model = None

def get_model():
    global model
    if model is None:
        print(f"モデル読み込み中: {MODEL_SIZE} ({DEVICE}, {COMPUTE_TYPE})...")
        model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
        print("モデル読み込み完了")
    return model


def process_ai_assistant(text: str):
    """
    文字起こしテキストをAIアシスタントサービスにHTTP経由で送信する。
    バックグラウンドスレッドで実行し、文字起こしをブロックしない。
    """
    async def send_query():
        import aiohttp

        url = f"http://{ASSISTANT_HOST}:{ASSISTANT_PORT}/query"
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                json={"query": text, "check_wake_word": True},
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                return await resp.json()

    def run():
        try:
            response = asyncio.run(send_query())

            if "skipped" in response:
                pass  # ウェイクワードなし、何もしない
            elif "error" in response:
                print(f"  [AI] エラー: {response['error']}")
            elif "response" in response:
                print(f"  [AI] 応答完了")

        except Exception as e:
            # アシスタントサービスが起動していない場合は静かに失敗
            if "Cannot connect" not in str(e) and "Connection refused" not in str(e):
                print(f"  [AI] エラー: {e}")

    # バックグラウンドで実行
    thread = threading.Thread(target=run, daemon=True)
    thread.start()

def format_time(seconds):
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    milliseconds = int((seconds % 1) * 1000)
    return f"{int(hours):02d}:{int(minutes):02d}:{int(seconds):02d},{milliseconds:03d}"

def transcribe_to_srt(wav_path, quiet=False):
    """WAVファイルを文字起こししてSRTファイルを保存

    Args:
        wav_path: WAVファイルパス
        quiet: Trueの場合、詳細ログを抑制（初期スキャン用）
    """
    wav_path = Path(wav_path)
    srt_path = wav_path.with_suffix(".srt")

    if srt_path.exists():
        if not quiet:
            print(f"スキップ（SRT存在）: {wav_path.name}")
        return

    if not quiet:
        print(f"文字起こし開始: {wav_path.name}")

    m = get_model()
    segments, info = m.transcribe(
        str(wav_path),
        language="ja",
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=1000),
    )

    if not quiet:
        print(f"  言語: {info.language} (確率: {info.language_probability:.2f})")

    # ジェネレータを一度リストに変換してから処理
    segment_list = list(segments)

    if len(segment_list) == 0:
        if not quiet:
            print(f"  セグメントなし（無音ファイル？）")
        return

    with open(srt_path, "w", encoding="utf-8") as f:
        for i, segment in enumerate(segment_list, start=1):
            text = segment.text.strip()
            if not quiet:
                print(f"  [{segment.start:.2f}s -> {segment.end:.2f}s] {text}")
            f.write(f"{i}\n")
            f.write(f"{format_time(segment.start)} --> {format_time(segment.end)}\n")
            f.write(f"{text}\n\n")

    if not quiet:
        print(f"保存完了: {srt_path.name} ({len(segment_list)}セグメント)")

    # AI Assistant: ウェイクワード検出チェック（初期スキャンでは実行しない）
    if ENABLE_AI_ASSISTANT and not quiet:
        full_text = " ".join(segment.text.strip() for segment in segment_list)
        process_ai_assistant(full_text)

def scan_missing_srt():
    """起動時に*.wavをスキャンし、対応する*.srtがないものを処理"""
    if not RECORDINGS_DIR.exists():
        print(f"フォルダが存在しません: {RECORDINGS_DIR}")
        return

    wav_files = list(RECORDINGS_DIR.glob("*.wav"))
    missing = [f for f in wav_files if not f.with_suffix(".srt").exists()]

    if missing:
        print(f"  開始... ({len(missing)}件)")
        print(f"  処理中...", end="", flush=True)
        for wav_path in missing:
            transcribe_to_srt(wav_path, quiet=True)
        print(" 完了")
    else:
        print("  未処理ファイルなし")

class WavHandler(FileSystemEventHandler):
    """新規WAVファイル検出ハンドラー"""
    def on_created(self, event):
        if event.is_directory:
            return
        if event.src_path.endswith(".wav"):
            # ファイル書き込み完了を待つ（サイズが安定するまで）
            self.wait_for_file_complete(event.src_path)
            transcribe_to_srt(event.src_path)

    def wait_for_file_complete(self, filepath, timeout=60):
        """ファイルの書き込みが完了するまで待つ"""
        import os
        last_size = -1
        stable_count = 0
        elapsed = 0

        while elapsed < timeout:
            try:
                current_size = os.path.getsize(filepath)
                if current_size == last_size and current_size > 0:
                    stable_count += 1
                    if stable_count >= 2:  # 2秒間サイズ変化なし
                        return
                else:
                    stable_count = 0
                last_size = current_size
            except OSError:
                pass
            time.sleep(1)
            elapsed += 1

        print(f"  警告: ファイル完了待ちタイムアウト: {filepath}")

def main():
    print("=" * 50)
    print("  WAV → SRT 文字起こしサービス")
    print("=" * 50)
    print(f"  監視フォルダ: {RECORDINGS_DIR}")
    print(f"  モデル: {MODEL_SIZE}")
    print(f"  AIアシスタント: {'有効' if ENABLE_AI_ASSISTANT else '無効'}")
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
