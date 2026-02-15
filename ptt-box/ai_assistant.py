"""
AI音声アシスタント (FastMCP対応版)

独立したサービスとして動作し、TCP経由でクエリを受け付ける。
FastMCP を使用して外部ツール（filesystem, sqlite等）と連携。

Usage:
  # サービス起動
  uv run python ai_assistant.py

  # CLIテスト（サービス起動中に別ターミナルで）
  uv run python test_assistant.py "OKガーコ、在庫を確認して"
"""
import os
import sys
import json
import asyncio
import tempfile
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Any
from dotenv import load_dotenv

# ========== 環境変数読み込み ==========
load_dotenv()

# ========== 設定 ==========
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "gpt-4o-mini")
AI_RESPONSE_MAX_TOKENS = int(os.environ.get("AI_RESPONSE_MAX_TOKENS", "500"))
TTS_VOICE = os.environ.get("TTS_VOICE", "ja-JP-NanamiNeural")
TTS_ENABLED = os.environ.get("TTS_ENABLED", "true").lower() == "true"

# TCPサーバー設定
WS_HOST = os.environ.get("ASSISTANT_WS_HOST", "localhost")
WS_PORT = int(os.environ.get("ASSISTANT_WS_PORT", "9321"))

# MCP設定
MCP_CONFIG_PATH = Path(os.environ.get("MCP_CONFIG_PATH", Path(__file__).parent / "mcp_config.json"))
SANDBOX_PATH = Path(os.environ.get("SANDBOX_PATH", Path(__file__).parent / "sandbox"))

# ウェイクワードリスト
WAKE_WORDS_STR = os.environ.get("WAKE_WORDS", "OKガーコ,okガーコ,オーケーガーコ,ガーコちゃん")
WAKE_WORDS = [w.strip() for w in WAKE_WORDS_STR.split(",")]

# システムプロンプト
SYSTEM_PROMPT = """あなたはPTTトランシーバーのAIアシスタント「ガーコ」です。
音声で読み上げられるため、簡潔に応答してください。
句読点を適切に使い、読みやすい文章にしてください。

利用可能なツールを使って、在庫確認、ファイル操作、データベース操作などを行えます。
- ファイルシステムは sandbox/ ディレクトリ内のみアクセス可能です
- SQLiteデータベース(sandbox/data/assistant.db)には inventory, locations, memos テーブルがあります
"""


def log(msg: str):
    """ログ出力"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] [AI] {msg}", flush=True)


# ========== ウェイクワード検出 ==========

def check_wake_word(text: str) -> str | None:
    """テキストからウェイクワードを検出し、その後のクエリを返す。"""
    text_lower = text.lower()

    for wake_word in WAKE_WORDS:
        wake_word_lower = wake_word.lower()
        if wake_word_lower in text_lower:
            idx = text_lower.find(wake_word_lower)
            query = text[idx + len(wake_word):].strip()
            query = query.lstrip("、,，。.")
            if query:
                log(f"ウェイクワード検出: '{wake_word}' -> クエリ: '{query}'")
                return query
            else:
                log(f"ウェイクワード検出: '{wake_word}' (クエリなし)")
                return None
    return None


# ========== MCP クライアント (FastMCP) ==========

class MCPAssistant:
    """FastMCP統合AIアシスタント"""

    def __init__(self, config_path: Path = MCP_CONFIG_PATH):
        self.config_path = config_path
        self.mcp_client = None
        self.openai_client = None
        self.tools: list[dict] = []

    async def start(self):
        """アシスタントを起動"""
        log("MCPAssistant 起動中...")

        # OpenAI クライアント初期化
        if not OPENAI_API_KEY:
            log("警告: OPENAI_API_KEY が設定されていません")
        else:
            from openai import OpenAI
            self.openai_client = OpenAI(api_key=OPENAI_API_KEY)

        # MCP設定読み込み
        if not self.config_path.exists():
            log(f"MCP設定ファイルなし: {self.config_path}")
            log("MCPAssistant 準備完了 (ツール: 0個)")
            return

        try:
            from fastmcp import Client

            with open(self.config_path, "r", encoding="utf-8") as f:
                config = json.load(f)

            # FastMCP クライアント作成
            self.mcp_client = Client(config)

            # 接続してツール一覧取得
            await self.mcp_client.__aenter__()

            tools = await self.mcp_client.list_tools()
            self.tools = tools
            log(f"MCPAssistant 準備完了 (ツール: {len(self.tools)}個)")

            # ツール名を表示
            for tool in self.tools:
                tool_name = tool.name if hasattr(tool, 'name') else tool.get('name', 'unknown')
                log(f"  - {tool_name}")

        except Exception as e:
            log(f"MCP初期化エラー: {e}")
            self.mcp_client = None
            log("MCPAssistant 準備完了 (ツール: 0個)")

    async def stop(self):
        """アシスタントを停止"""
        if self.mcp_client:
            try:
                await self.mcp_client.__aexit__(None, None, None)
            except Exception:
                pass
        log("MCPAssistant 停止")

    def _convert_tools_to_openai(self) -> list[dict]:
        """MCPツールをOpenAI形式に変換"""
        openai_tools = []
        for tool in self.tools:
            # FastMCP Tool オブジェクトの場合
            if hasattr(tool, 'name'):
                name = tool.name
                description = tool.description or ""
                parameters = tool.inputSchema if hasattr(tool, 'inputSchema') else {"type": "object", "properties": {}}
            else:
                # dict の場合
                name = tool.get('name', '')
                description = tool.get('description', '')
                parameters = tool.get('inputSchema', {"type": "object", "properties": {}})

            openai_tools.append({
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": parameters
                }
            })
        return openai_tools

    async def _execute_tool(self, name: str, arguments: dict) -> str:
        """ツールを実行して結果を返す"""
        if not self.mcp_client:
            return "MCPクライアントが初期化されていません"

        try:
            log(f"ツール実行: {name}({json.dumps(arguments, ensure_ascii=False)[:50]}...)")
            result = await self.mcp_client.call_tool(name, arguments)

            # 結果を文字列化
            if hasattr(result, 'content'):
                # TextContent などの場合
                if isinstance(result.content, list):
                    texts = []
                    for item in result.content:
                        if hasattr(item, 'text'):
                            texts.append(item.text)
                        else:
                            texts.append(str(item))
                    return "\n".join(texts)
                return str(result.content)
            elif isinstance(result, dict):
                return json.dumps(result, ensure_ascii=False, indent=2)
            else:
                return str(result)

        except Exception as e:
            log(f"ツール実行エラー: {e}")
            return f"ツール実行エラー: {e}"

    async def process_query(self, query: str) -> str:
        """クエリを処理して応答を生成"""
        if not self.openai_client:
            return "OpenAI APIが設定されていません"

        log(f"クエリ処理: {query}")

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": query}
        ]

        tools = self._convert_tools_to_openai() if self.tools else None

        try:
            # 最大5回のツール呼び出しループ
            for iteration in range(5):
                response = self.openai_client.chat.completions.create(
                    model=AI_MODEL,
                    max_tokens=AI_RESPONSE_MAX_TOKENS,
                    messages=messages,
                    tools=tools if tools else None,
                )

                choice = response.choices[0]

                # ツール呼び出しがなければ終了
                if not choice.message.tool_calls:
                    result = choice.message.content or ""
                    log(f"応答生成完了: {result[:50]}...")
                    return result

                # ツール呼び出しを実行
                messages.append(choice.message)

                for tool_call in choice.message.tool_calls:
                    arguments = json.loads(tool_call.function.arguments)
                    result = await self._execute_tool(
                        tool_call.function.name,
                        arguments
                    )
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": result
                    })

            return "処理が複雑すぎます。もう少し簡単な質問をしてください。"

        except Exception as e:
            log(f"エラー: {e}")
            return f"エラーが発生しました: {e}"


# ========== TTS ==========

async def text_to_speech(text: str) -> Path | None:
    """edge-ttsで音声合成"""
    if not TTS_ENABLED:
        return None

    try:
        import edge_tts

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            output_path = Path(f.name)

        communicate = edge_tts.Communicate(text, TTS_VOICE)
        await communicate.save(str(output_path))

        return output_path
    except Exception as e:
        log(f"TTSエラー: {e}")
        return None


def play_audio(audio_path: Path) -> bool:
    """音声ファイルを再生"""
    try:
        result = subprocess.run(
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", str(audio_path)],
            capture_output=True,
            text=True
        )
        return result.returncode == 0
    except Exception as e:
        log(f"再生エラー: {e}")
        return False


# ========== TCP サービス ==========

class AssistantService:
    """TCPサービス"""

    def __init__(self, host: str = WS_HOST, port: int = WS_PORT):
        self.host = host
        self.port = port
        self.assistant = MCPAssistant()

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        """クライアント接続を処理"""
        addr = writer.get_extra_info('peername')
        log(f"接続: {addr}")

        try:
            while True:
                data = await reader.readline()
                if not data:
                    break

                try:
                    message = json.loads(data.decode())
                    await self._handle_message(message, writer)
                except json.JSONDecodeError:
                    await self._send_response(writer, {"error": "Invalid JSON"})
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log(f"エラー: {e}")
        finally:
            writer.close()
            await writer.wait_closed()
            log(f"切断: {addr}")

    async def _handle_message(self, message: dict, writer: asyncio.StreamWriter):
        """メッセージを処理"""
        msg_type = message.get("type", "query")

        if msg_type == "query":
            query = message.get("query", "")
            if not query:
                await self._send_response(writer, {"error": "Empty query"})
                return

            # ウェイクワードチェック
            if message.get("check_wake_word", False):
                query = check_wake_word(query)
                if not query:
                    await self._send_response(writer, {"skipped": True, "reason": "No wake word"})
                    return

            # クエリ処理
            response_text = await self.assistant.process_query(query)

            # TTS生成・再生
            if TTS_ENABLED:
                audio_path = await text_to_speech(response_text)
                if audio_path:
                    play_audio(audio_path)
                    audio_path.unlink(missing_ok=True)

            await self._send_response(writer, {"response": response_text})

        elif msg_type == "ping":
            await self._send_response(writer, {"type": "pong"})

        elif msg_type == "status":
            await self._send_response(writer, {
                "status": "running",
                "tools": len(self.assistant.tools),
                "tool_names": [t.name if hasattr(t, 'name') else t.get('name') for t in self.assistant.tools]
            })

        else:
            await self._send_response(writer, {"error": f"Unknown type: {msg_type}"})

    async def _send_response(self, writer: asyncio.StreamWriter, response: dict):
        """レスポンスを送信"""
        writer.write((json.dumps(response, ensure_ascii=False) + "\n").encode())
        await writer.drain()

    async def start(self):
        """サービスを起動"""
        print("=" * 50)
        print("  AI音声アシスタント (FastMCP対応)")
        print("=" * 50)
        print(f"  モデル: {AI_MODEL}")
        print(f"  TTSボイス: {TTS_VOICE}")
        print(f"  ウェイクワード: {WAKE_WORDS}")
        print(f"  サーバー: {self.host}:{self.port}")
        print()

        # MCPアシスタント起動
        await self.assistant.start()
        print()

        # TCPサーバー起動
        server = await asyncio.start_server(
            self.handle_client,
            self.host,
            self.port
        )

        log(f"サービス起動完了 - {self.host}:{self.port}")
        print("  Ctrl+C で終了")
        print()

        try:
            async with server:
                await server.serve_forever()
        except asyncio.CancelledError:
            pass
        finally:
            await self.assistant.stop()


# ========== メイン ==========

def main():
    service = AssistantService()
    try:
        asyncio.run(service.start())
    except KeyboardInterrupt:
        print("\n終了")


if __name__ == "__main__":
    main()
