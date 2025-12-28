import os
import time
import ftplib
from pathlib import Path
from dotenv import load_dotenv
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# ========== 環境変数読み込み ==========
load_dotenv()

FTP_SERVER_URL = os.environ.get("FTP_SERVER_URL")
FTP_USER_ID = os.environ.get("FTP_USER_ID")
FTP_PASSWORD = os.environ.get("FTP_PASSWORD")
REMOTE_FILE_DIR = os.environ.get("REMOTE_FILE_DIR", "/")
MAX_REMOTE_FILES = int(os.environ.get("MAX_REMOTE_FILES", "200"))

# ========== 設定 ==========
RECORDINGS_DIR = Path(__file__).parent / "recordings"
TARGET_EXTENSIONS = (".wav", ".srt")


def get_updone_path(file_path):
    """アップロード完了マーカーファイルのパスを取得"""
    return Path(str(file_path) + ".updone")


def is_uploaded(file_path):
    """アップロード済みかどうかを確認"""
    return get_updone_path(file_path).exists()


def mark_uploaded(file_path):
    """アップロード完了マーカーを作成"""
    updone_path = get_updone_path(file_path)
    updone_path.touch()
    print(f"  マーカー作成: {updone_path.name}")


def extract_datetime_from_filename(filename):
    """ファイル名から日時文字列を抽出 (rec_YYYYMMDD_HHMMSS.wav or web_YYYYMMDD_HHMMSS.wav -> YYYYMMDD_HHMMSS)"""
    import re
    match = re.search(r'(?:rec|web)_(\d{8}_\d{6})', filename)
    if match:
        return match.group(1)
    return "00000000_000000"


def get_remote_wav_files(ftp):
    """リモートのrec_*.wavおよびweb_*.wavファイル一覧を取得"""
    try:
        ftp.cwd(REMOTE_FILE_DIR)
        files = ftp.nlst()
        wav_files = [f for f in files if (f.startswith("rec_") or f.startswith("web_")) and f.endswith(".wav")]
        return wav_files
    except Exception as e:
        print(f"  リモートファイル一覧取得失敗: {e}")
        return []


def cleanup_old_files(ftp):
    """古いファイルをペアで削除して最大数以下に"""
    wav_files = get_remote_wav_files(ftp)

    if len(wav_files) < MAX_REMOTE_FILES:
        return

    # 日時順にソート（古い順）
    wav_files.sort(key=extract_datetime_from_filename)

    # 削除が必要な数
    delete_count = len(wav_files) - MAX_REMOTE_FILES + 1  # 新規アップロード分の1を確保

    print(f"  リモートファイル数: {len(wav_files)} (最大: {MAX_REMOTE_FILES})")
    print(f"  {delete_count}ペアを削除します")

    for i in range(delete_count):
        wav_file = wav_files[i]
        srt_file = wav_file.replace(".wav", ".srt")

        try:
            ftp.delete(f"{REMOTE_FILE_DIR}/{wav_file}")
            print(f"  削除: {wav_file}")
        except Exception as e:
            print(f"  削除失敗: {wav_file} - {e}")

        try:
            ftp.delete(f"{REMOTE_FILE_DIR}/{srt_file}")
            print(f"  削除: {srt_file}")
        except Exception:
            pass  # SRTがない場合は無視


def upload_file(file_path):
    """単一ファイルをFTPアップロード"""
    file_path = Path(file_path)

    if not file_path.exists():
        print(f"  ファイルが存在しません: {file_path.name}")
        return False

    if is_uploaded(file_path):
        print(f"  スキップ（アップロード済み）: {file_path.name}")
        return True

    print(f"アップロード開始: {file_path.name}")

    try:
        ftp = ftplib.FTP(FTP_SERVER_URL)
        ftp.set_pasv(True)
        ftp.login(FTP_USER_ID, FTP_PASSWORD)

        # 古いファイルを削除してファイル数を制限
        cleanup_old_files(ftp)

        remote_path = f"{REMOTE_FILE_DIR}/{file_path.name}"

        with open(file_path, "rb") as f:
            ftp.storbinary(f"STOR {remote_path}", f)

        ftp.quit()

        mark_uploaded(file_path)
        print(f"  アップロード完了: {file_path.name}")
        return True

    except Exception as e:
        print(f"  アップロード失敗: {file_path.name} - {e}")
        return False


def scan_missing_uploads():
    """起動時に未アップロードファイルをスキャン"""
    if not RECORDINGS_DIR.exists():
        print(f"フォルダが存在しません: {RECORDINGS_DIR}")
        return

    uploaded_count = 0
    skipped_count = 0

    for ext in TARGET_EXTENSIONS:
        files = list(RECORDINGS_DIR.glob(f"*{ext}"))
        for file_path in files:
            if is_uploaded(file_path):
                skipped_count += 1
            else:
                if upload_file(file_path):
                    uploaded_count += 1

    print(f"  アップロード: {uploaded_count}件, スキップ: {skipped_count}件")


class UploadHandler(FileSystemEventHandler):
    """WAV/SRTファイル作成検出ハンドラー"""

    def on_created(self, event):
        if event.is_directory:
            return

        src_path = event.src_path

        # 対象拡張子かチェック
        if not any(src_path.endswith(ext) for ext in TARGET_EXTENSIONS):
            return

        # .updoneファイルは無視
        if src_path.endswith(".updone"):
            return

        # ファイル書き込み完了を待つ（サイズが安定するまで）
        self.wait_for_file_complete(src_path)

        upload_file(src_path)

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


def check_config():
    """環境変数の設定確認"""
    missing = []
    if not FTP_SERVER_URL:
        missing.append("FTP_SERVER_URL")
    if not FTP_USER_ID:
        missing.append("FTP_USER_ID")
    if not FTP_PASSWORD:
        missing.append("FTP_PASSWORD")

    if missing:
        print("エラー: 以下の環境変数が設定されていません:")
        for var in missing:
            print(f"  - {var}")
        print("\n.envファイルを作成してください。")
        print("参考: .env.example")
        return False

    return True


def main():
    print("=" * 50)
    print("  FTP アップロードサービス")
    print("=" * 50)
    print(f"  監視フォルダ: {RECORDINGS_DIR}")
    print(f"  対象: {', '.join(TARGET_EXTENSIONS)}")
    print(f"  FTPサーバー: {FTP_SERVER_URL}")
    print(f"  リモートディレクトリ: {REMOTE_FILE_DIR}")
    print(f"  最大ファイル数: {MAX_REMOTE_FILES}")
    print()

    # 設定確認
    if not check_config():
        return

    # 初期スキャン
    print("[1] 初期スキャン")
    scan_missing_uploads()
    print()

    # フォルダ監視開始
    print("[2] フォルダ監視開始")
    print("  Ctrl+C で終了")
    print()

    RECORDINGS_DIR.mkdir(exist_ok=True)

    event_handler = UploadHandler()
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
