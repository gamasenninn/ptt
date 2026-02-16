"""
AI音声アシスタント テストクライアント (HTTP版)

ai_assistant.py サービスに接続してテストを行う。

Usage:
  # サービスが起動していることを確認
  # uv run python ai_assistant.py

  # ウェイクワード込みでテスト
  uv run python test_assistant.py "OKガーコ、在庫を確認して"

  # クエリ直接テスト（ウェイクワードなし）
  uv run python test_assistant.py --direct "在庫を確認して"

  # ステータス確認
  uv run python test_assistant.py --status

  # インタラクティブモード
  uv run python test_assistant.py
"""
import sys
import json
import asyncio
from dotenv import load_dotenv
import os

load_dotenv()

# 後方互換: 旧WS_*変数もサポート
HOST = os.environ.get("ASSISTANT_HOST", os.environ.get("ASSISTANT_WS_HOST", "localhost"))
PORT = int(os.environ.get("ASSISTANT_PORT", os.environ.get("ASSISTANT_WS_PORT", "9321")))
BASE_URL = f"http://{HOST}:{PORT}"


async def send_query(query: str, check_wake_word: bool = True) -> dict:
    """HTTPでクエリを送信"""
    import aiohttp

    url = f"{BASE_URL}/query"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                json={"query": query, "check_wake_word": check_wake_word},
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                return await resp.json()
    except aiohttp.ClientConnectorError:
        return {"error": f"接続失敗: {url} - サービスが起動していません"}
    except asyncio.TimeoutError:
        return {"error": "タイムアウト"}
    except Exception as e:
        return {"error": f"エラー: {e}"}


async def get_status() -> dict:
    """ステータスを取得"""
    import aiohttp

    url = f"{BASE_URL}/status"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                return await resp.json()
    except aiohttp.ClientConnectorError:
        return {"error": f"接続失敗: {url} - サービスが起動していません"}
    except Exception as e:
        return {"error": f"エラー: {e}"}


async def query(text: str, check_wake_word: bool = True) -> str:
    """クエリを送信して応答を取得"""
    response = await send_query(text, check_wake_word)

    if "error" in response:
        return f"エラー: {response['error']}"
    if "skipped" in response:
        return f"スキップ: {response.get('reason', 'ウェイクワードなし')}"
    return response.get("response", "応答なし")


async def interactive_mode():
    """インタラクティブモード"""
    print("クエリを入力してください（Ctrl+C で終了）")
    print("  例: OKガーコ、在庫を確認して")
    print("  例: !direct 今日の天気は？  (ウェイクワードスキップ)")
    print("  例: !status  (ステータス確認)")
    print()

    try:
        while True:
            text = input("> ").strip()
            if not text:
                continue

            if text == "!status":
                result = await get_status()
                print(f"  {result}")
            elif text.startswith("!direct "):
                query_text = text[8:].strip()
                result = await query(query_text, check_wake_word=False)
                print(f"  {result}")
            else:
                result = await query(text, check_wake_word=True)
                print(f"  {result}")
            print()

    except KeyboardInterrupt:
        print("\n終了")


async def main():
    print("=" * 50)
    print("  AI音声アシスタント テストクライアント (HTTP)")
    print("=" * 50)
    print(f"  接続先: {BASE_URL}")
    print()

    if len(sys.argv) > 1:
        if sys.argv[1] == "--status":
            result = await get_status()
            print(f"ステータス: {json.dumps(result, ensure_ascii=False, indent=2)}")

        elif sys.argv[1] == "--direct":
            text = " ".join(sys.argv[2:])
            print(f"[直接クエリ] {text}")
            print()
            result = await query(text, check_wake_word=False)
            print(f"応答: {result}")

        else:
            text = " ".join(sys.argv[1:])
            print(f"[入力] {text}")
            print()
            result = await query(text, check_wake_word=True)
            print(f"応答: {result}")

    else:
        await interactive_mode()


if __name__ == "__main__":
    asyncio.run(main())
