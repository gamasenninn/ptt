"""
AI音声アシスタント (FastMCP対応版)

独立したサービスとして動作し、HTTP経由でクエリを受け付ける。
FastMCP を使用して外部ツール（filesystem, sqlite等）と連携。

Usage:
  # サービス起動
  uv run python ai_assistant.py

  # CLIテスト（サービス起動中に別ターミナルで）
  uv run python test_assistant.py "OKガーコ、在庫を確認して"

  # curlテスト
  curl -X POST http://localhost:9321/query -H "Content-Type: application/json" -d '{"query": "今何時？"}'
  curl http://localhost:9321/status
"""
import os
import sys
import json
import asyncio
import tempfile
import subprocess
import logging
from pathlib import Path
from datetime import datetime
from typing import Any
from dotenv import load_dotenv

# ========== 環境変数読み込み ==========
load_dotenv()

# ========== ログ設定 ==========
LOG_DIR = Path(os.environ.get("ASSISTANT_LOG_DIR", Path(__file__).parent / "logs"))
LOG_RETENTION_DAYS = int(os.environ.get("ASSISTANT_LOG_RETENTION_DAYS", "30"))
ENABLE_FILE_LOG = os.environ.get("ASSISTANT_ENABLE_FILE_LOG", "true").lower() == "true"

# ログディレクトリ作成
if ENABLE_FILE_LOG:
    LOG_DIR.mkdir(exist_ok=True)

# ロガー設定
logger = logging.getLogger("ai_assistant")
logger.setLevel(logging.DEBUG)

# コンソールハンドラ
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(logging.Formatter("[%(asctime)s] [AI] %(message)s", datefmt="%H:%M:%S"))
logger.addHandler(console_handler)

# ファイルハンドラ（日付別ファイル）
if ENABLE_FILE_LOG:
    today = datetime.now().strftime("%Y-%m-%d")
    log_file = LOG_DIR / f"assistant-{today}.log"
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    ))
    logger.addHandler(file_handler)

# ========== 設定 ==========
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "gpt-4o-mini")
AI_RESPONSE_MAX_TOKENS = int(os.environ.get("AI_RESPONSE_MAX_TOKENS", "500"))
TTS_VOICE = os.environ.get("TTS_VOICE", "ja-JP-NanamiNeural")
TTS_ENABLED = os.environ.get("TTS_ENABLED", "true").lower() == "true"

# HTTPサーバー設定 (後方互換: 旧WS_*変数もサポート)
HTTP_HOST = os.environ.get("ASSISTANT_HOST", os.environ.get("ASSISTANT_WS_HOST", "localhost"))
HTTP_PORT = int(os.environ.get("ASSISTANT_PORT", os.environ.get("ASSISTANT_WS_PORT", "9321")))

# MCP設定
MCP_CONFIG_PATH = Path(os.environ.get("MCP_CONFIG_PATH", Path(__file__).parent / "mcp_config.json"))
SANDBOX_PATH = Path(os.environ.get("SANDBOX_PATH", Path(__file__).parent / "sandbox"))

# ウェイクワードリスト
WAKE_WORDS_STR = os.environ.get("WAKE_WORDS", "OKガーコ,okガーコ,オーケーガーコ,ガーコちゃん")
WAKE_WORDS = [w.strip() for w in WAKE_WORDS_STR.split(",")]

# システムプロンプト（外部ファイルから読み込み）
SYSTEM_PROMPT_PATH = Path(os.environ.get("SYSTEM_PROMPT_PATH", Path(__file__).parent / "ASSISTANT.md"))

def load_system_prompt() -> str:
    """システムプロンプトを外部ファイルから読み込む"""
    if SYSTEM_PROMPT_PATH.exists():
        return SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    else:
        return "あなたはAIアシスタントです。簡潔に応答してください。"


def log(msg: str, level: str = "info"):
    """ログ出力"""
    if level == "debug":
        logger.debug(msg)
    elif level == "warning":
        logger.warning(msg)
    elif level == "error":
        logger.error(msg)
    else:
        logger.info(msg)


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
            args_str = json.dumps(arguments, ensure_ascii=False)
            log(f"ツール実行: {name}({args_str[:50]}...)")
            log(f"ツール引数: {name} -> {args_str}", level="debug")

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
                    result_str = "\n".join(texts)
                else:
                    result_str = str(result.content)
            elif isinstance(result, dict):
                result_str = json.dumps(result, ensure_ascii=False, indent=2)
            else:
                result_str = str(result)

            log(f"ツール結果: {name} -> {result_str[:200]}...", level="debug")
            return result_str

        except Exception as e:
            log(f"ツール実行エラー: {name} -> {e}", level="error")
            return f"ツール実行エラー: {e}"

    async def process_query(self, query: str) -> str:
        """クエリを処理して応答を生成"""
        if not self.openai_client:
            return "OpenAI APIが設定されていません"

        log(f"クエリ処理: {query}")
        log(f"クエリ詳細: model={AI_MODEL}, max_tokens={AI_RESPONSE_MAX_TOKENS}", level="debug")

        messages = [
            {"role": "system", "content": load_system_prompt()},
            {"role": "user", "content": query}
        ]

        tools = self._convert_tools_to_openai() if self.tools else None
        tool_calls_made = []

        try:
            # 最大5回のツール呼び出しループ
            for iteration in range(5):
                log(f"APIリクエスト (iteration={iteration+1})", level="debug")

                response = self.openai_client.chat.completions.create(
                    model=AI_MODEL,
                    max_tokens=AI_RESPONSE_MAX_TOKENS,
                    messages=messages,
                    tools=tools if tools else None,
                )

                choice = response.choices[0]
                log(f"API応答: finish_reason={choice.finish_reason}", level="debug")

                # ツール呼び出しがなければ終了
                if not choice.message.tool_calls:
                    result = choice.message.content or ""
                    log(f"応答生成完了: {result[:50]}...")
                    log(f"応答全文: {result}", level="debug")

                    # ツール使用状況をログ
                    if tool_calls_made:
                        log(f"使用ツール: {', '.join(tool_calls_made)}", level="debug")
                    else:
                        log(f"ツール未使用で回答", level="debug")

                    return result

                # ツール呼び出しを実行
                messages.append(choice.message)

                for tool_call in choice.message.tool_calls:
                    tool_name = tool_call.function.name
                    tool_calls_made.append(tool_name)
                    arguments = json.loads(tool_call.function.arguments)
                    result = await self._execute_tool(tool_name, arguments)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": result
                    })

            log("最大反復回数に到達", level="warning")
            return "処理が複雑すぎます。もう少し簡単な質問をしてください。"

        except Exception as e:
            log(f"エラー: {e}", level="error")
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


# ========== HTTP サービス ==========

class AssistantService:
    """HTTPサービス (aiohttp)"""

    def __init__(self, host: str = HTTP_HOST, port: int = HTTP_PORT):
        self.host = host
        self.port = port
        self.assistant = MCPAssistant()
        self.runner = None

    async def handle_query(self, request):
        """POST /query - クエリ処理"""
        from aiohttp import web

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        query = data.get("query", "")
        if not query:
            return web.json_response({"error": "Empty query"}, status=400)

        # ウェイクワードチェック
        if data.get("check_wake_word", False):
            query = check_wake_word(query)
            if not query:
                return web.json_response({"skipped": True, "reason": "No wake word"})

        log(f"クエリ受信: {query[:50]}...")

        # クエリ処理
        response_text = await self.assistant.process_query(query)

        # TTS生成・再生
        if TTS_ENABLED:
            audio_path = await text_to_speech(response_text)
            if audio_path:
                play_audio(audio_path)
                audio_path.unlink(missing_ok=True)

        return web.json_response({"response": response_text})

    async def handle_status(self, request):
        """GET /status - ステータス取得"""
        from aiohttp import web

        return web.json_response({
            "status": "running",
            "tools": len(self.assistant.tools),
            "tool_names": [t.name if hasattr(t, 'name') else t.get('name') for t in self.assistant.tools]
        })

    async def start(self):
        """サービスを起動"""
        from aiohttp import web

        print("=" * 50)
        print("  AI音声アシスタント (HTTP)")
        print("=" * 50)
        print(f"  モデル: {AI_MODEL}")
        print(f"  TTSボイス: {TTS_VOICE}")
        print(f"  ウェイクワード: {WAKE_WORDS}")
        print(f"  HTTP: http://{self.host}:{self.port}")
        print()

        # MCPアシスタント起動
        await self.assistant.start()
        print()

        # HTTPサーバー起動
        app = web.Application()
        app.router.add_post('/query', self.handle_query)
        app.router.add_get('/status', self.handle_status)

        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, self.host, self.port)
        await site.start()

        log(f"サービス起動完了 - http://{self.host}:{self.port}")
        print("  Ctrl+C で終了")
        print()

        try:
            await asyncio.Future()  # 永久待機
        except asyncio.CancelledError:
            pass
        finally:
            await self.stop()

    async def stop(self):
        """サービスを停止"""
        await self.assistant.stop()
        if self.runner:
            await self.runner.cleanup()


# ========== メイン ==========

def main():
    service = AssistantService()
    try:
        asyncio.run(service.start())
    except KeyboardInterrupt:
        print("\n終了")


if __name__ == "__main__":
    main()
