"""
AI音声アシスタント

ウェイクワード検出後のクエリをOpenAI APIで処理し、
edge-ttsで音声合成してスピーカーから出力する。

Usage:
  # 単体テスト
  python ai_assistant.py "今何時？"

  # transcriber.py から呼び出される
"""
import os
import sys
import asyncio
import tempfile
import subprocess
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv

# ========== 環境変数読み込み ==========
load_dotenv()

# ========== 設定 ==========
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "gpt-4o-mini")
AI_RESPONSE_MAX_TOKENS = int(os.environ.get("AI_RESPONSE_MAX_TOKENS", "200"))
TTS_VOICE = os.environ.get("TTS_VOICE", "ja-JP-NanamiNeural")
SPEAKER_DEVICE_ID = os.environ.get("SPEAKER_DEVICE_ID", "0")
RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", Path(__file__).parent / "recordings"))

# ウェイクワードリスト
WAKE_WORDS_STR = os.environ.get("WAKE_WORDS", "OKガーコ,okガーコ,オーケーガーコ,ガーコちゃん")
WAKE_WORDS = [w.strip() for w in WAKE_WORDS_STR.split(",")]


def log(msg):
    """ログ出力"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] [AI] {msg}", flush=True)


def check_wake_word(text: str) -> str | None:
    """
    テキストからウェイクワードを検出し、その後のクエリを返す。

    Args:
        text: 文字起こしテキスト

    Returns:
        クエリ文字列（ウェイクワードが見つかった場合）、なければNone
    """
    text_lower = text.lower()

    for wake_word in WAKE_WORDS:
        wake_word_lower = wake_word.lower()
        if wake_word_lower in text_lower:
            # ウェイクワード以降をクエリとして抽出
            idx = text_lower.find(wake_word_lower)
            query = text[idx + len(wake_word):].strip()

            # クエリが空でないことを確認
            if query:
                log(f"ウェイクワード検出: '{wake_word}' -> クエリ: '{query}'")
                return query
            else:
                log(f"ウェイクワード検出: '{wake_word}' (クエリなし)")
                return None

    return None


def generate_response(query: str) -> str | None:
    """
    OpenAI APIで応答を生成する。

    Args:
        query: ユーザーのクエリ

    Returns:
        生成された応答テキスト、エラー時はNone
    """
    if not OPENAI_API_KEY:
        log("エラー: OPENAI_API_KEY が設定されていません")
        return None

    try:
        from openai import OpenAI

        client = OpenAI(api_key=OPENAI_API_KEY)

        log(f"OpenAI API呼び出し中... (model={AI_MODEL})")

        response = client.chat.completions.create(
            model=AI_MODEL,
            max_tokens=AI_RESPONSE_MAX_TOKENS,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "あなたはPTTトランシーバーのAIアシスタントです。"
                        "音声で読み上げられるため、簡潔に応答してください。"
                        "句読点を適切に使い、読みやすい文章にしてください。"
                    )
                },
                {"role": "user", "content": query}
            ]
        )

        result = response.choices[0].message.content
        log(f"応答生成完了: '{result[:50]}...' ({len(result)}文字)")
        return result

    except ImportError:
        log("エラー: openai パッケージがインストールされていません")
        log("  pip install openai を実行してください")
        return None
    except Exception as e:
        log(f"OpenAI APIエラー: {e}")
        return None


async def text_to_speech_async(text: str, output_path: Path) -> bool:
    """
    edge-ttsで音声合成を行う（非同期版）。

    Args:
        text: 読み上げるテキスト
        output_path: 出力MP3ファイルパス

    Returns:
        成功時True
    """
    try:
        import edge_tts

        log(f"TTS変換中... (voice={TTS_VOICE})")

        communicate = edge_tts.Communicate(text, TTS_VOICE)
        await communicate.save(str(output_path))

        log(f"TTS完了: {output_path.name}")
        return True

    except ImportError:
        log("エラー: edge-tts パッケージがインストールされていません")
        log("  pip install edge-tts を実行してください")
        return False
    except Exception as e:
        log(f"TTSエラー: {e}")
        return False


def text_to_speech(text: str, output_path: Path) -> bool:
    """edge-ttsで音声合成を行う（同期版ラッパー）。"""
    return asyncio.run(text_to_speech_async(text, output_path))


def play_audio(audio_path: Path) -> bool:
    """
    音声ファイルをスピーカーから再生する。

    ffplayを使用してシンプルに再生。

    Args:
        audio_path: 再生する音声ファイルパス

    Returns:
        成功時True
    """
    try:
        log(f"音声再生中: {audio_path.name}")

        # ffplayで再生（autoexit, 無音出力）
        result = subprocess.run(
            [
                "ffplay",
                "-nodisp",      # ウィンドウなし
                "-autoexit",    # 再生後自動終了
                "-loglevel", "error",
                str(audio_path)
            ],
            capture_output=True,
            text=True
        )

        if result.returncode != 0:
            log(f"ffplay エラー: {result.stderr}")
            return False

        log("音声再生完了")
        return True

    except FileNotFoundError:
        log("エラー: ffplay が見つかりません")
        return False
    except Exception as e:
        log(f"再生エラー: {e}")
        return False


def process_query(query: str) -> bool:
    """
    クエリを処理して音声応答を生成・再生する。

    Args:
        query: ユーザーのクエリ

    Returns:
        成功時True
    """
    log(f"クエリ処理開始: '{query}'")

    # 1. OpenAI APIで応答生成
    response = generate_response(query)
    if not response:
        return False

    # 2. 一時ファイルでTTS
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        tts_path = Path(f.name)

    try:
        # 3. TTS実行
        if not text_to_speech(response, tts_path):
            return False

        # 4. 音声再生
        if not play_audio(tts_path):
            return False

        return True

    finally:
        # 一時ファイル削除
        try:
            tts_path.unlink()
        except Exception:
            pass


def process_transcription(text: str) -> bool:
    """
    文字起こしテキストを処理する（transcriber.pyから呼び出し用）。

    ウェイクワードを検出し、検出された場合はAI応答を生成して再生する。

    Args:
        text: 文字起こしテキスト

    Returns:
        ウェイクワードが検出され処理が行われた場合True
    """
    query = check_wake_word(text)
    if query:
        return process_query(query)
    return False


# ========== メイン ==========
def main():
    """CLIエントリーポイント（テスト用）"""
    print("=" * 50)
    print("  AI音声アシスタント")
    print("=" * 50)
    print(f"  モデル: {AI_MODEL}")
    print(f"  TTSボイス: {TTS_VOICE}")
    print(f"  ウェイクワード: {WAKE_WORDS}")
    print()

    if len(sys.argv) > 1:
        # コマンドライン引数をクエリとして処理
        query = " ".join(sys.argv[1:])
        print(f"クエリ: {query}")
        print()
        process_query(query)
    else:
        # インタラクティブモード
        print("クエリを入力してください（Ctrl+C で終了）:")
        print()

        try:
            while True:
                query = input("> ").strip()
                if query:
                    process_query(query)
                    print()
        except KeyboardInterrupt:
            print("\n終了")


if __name__ == "__main__":
    main()
