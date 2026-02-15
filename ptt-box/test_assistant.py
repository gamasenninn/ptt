"""
AI音声アシスタント テストスクリプト

transcriber.py を使わずに単体でテストできる。

Usage:
  # ウェイクワード込みでテスト（実際の発話をシミュレート）
  uv run python test_assistant.py "OKガーコ、今何時？"

  # クエリ直接テスト（ウェイクワードなし）
  uv run python test_assistant.py --direct "今何時？"

  # インタラクティブモード
  uv run python test_assistant.py
"""
import sys
from ai_assistant import (
    check_wake_word,
    process_query,
    process_transcription,
    WAKE_WORDS,
    AI_MODEL,
    TTS_VOICE,
)


def main():
    print("=" * 50)
    print("  AI音声アシスタント テスト")
    print("=" * 50)
    print(f"  モデル: {AI_MODEL}")
    print(f"  TTSボイス: {TTS_VOICE}")
    print(f"  ウェイクワード: {WAKE_WORDS}")
    print()

    if len(sys.argv) > 1:
        if sys.argv[1] == "--direct":
            # クエリ直接モード
            query = " ".join(sys.argv[2:])
            print(f"[直接クエリ] {query}")
            print()
            process_query(query)
        else:
            # ウェイクワード込みテスト
            text = " ".join(sys.argv[1:])
            print(f"[入力テキスト] {text}")
            print()
            result = process_transcription(text)
            if not result:
                print("ウェイクワードが検出されませんでした")
    else:
        # インタラクティブモード
        print("テキストを入力してください（Ctrl+C で終了）")
        print("  例: OKガーコ、今何時？")
        print("  例: ガーコちゃん、明日の天気は？")
        print()

        try:
            while True:
                text = input("> ").strip()
                if text:
                    result = process_transcription(text)
                    if not result:
                        print("  → ウェイクワード未検出")
                    print()
        except KeyboardInterrupt:
            print("\n終了")


if __name__ == "__main__":
    main()
