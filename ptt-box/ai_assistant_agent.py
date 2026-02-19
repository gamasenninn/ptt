"""
AI音声アシスタント (OpenAI Agent SDK版)

独立したサービスとして動作し、HTTP経由でクエリを受け付ける。
OpenAI Agent SDK + MCPで外部ツール（filesystem, sqlite等）と連携。

Usage:
  # サービス起動
  uv run python ai_assistant_agent.py

  # CLIテスト（サービス起動中に別ターミナルで）
  uv run python test_assistant.py "OKガーコ、在庫を確認して"

  # curlテスト
  curl -X POST http://localhost:9321/query -H "Content-Type: application/json" -d '{"query": "今何時？"}'
  curl http://localhost:9321/status

従来版（FastMCP）にフォールバックする場合:
  uv run python ai_assistant.py
"""
import os
import sys
import json
import asyncio
import tempfile
import logging
import time
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv

# ========== 環境変数読み込み ==========
load_dotenv()

# ========== ログ設定 ==========
LOG_DIR = Path(os.environ.get("ASSISTANT_LOG_DIR", Path(__file__).parent / "logs"))
LOG_RETENTION_DAYS = int(os.environ.get("ASSISTANT_LOG_RETENTION_DAYS", "30"))
ENABLE_FILE_LOG = os.environ.get("ASSISTANT_ENABLE_FILE_LOG", "true").lower() == "true"
DEBUG_MODE = os.environ.get("ASSISTANT_DEBUG", "true").lower() == "true"  # デフォルトでON
DEBUG_VERBOSE = os.environ.get("ASSISTANT_DEBUG_VERBOSE", "false").lower() == "true"  # 全文表示

# ログディレクトリ作成
if ENABLE_FILE_LOG:
    LOG_DIR.mkdir(exist_ok=True)

# ロガー設定
logger = logging.getLogger("ai_assistant_agent")
logger.setLevel(logging.DEBUG)

# コンソールハンドラ
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.DEBUG if DEBUG_MODE else logging.INFO)
console_handler.setFormatter(logging.Formatter("[%(asctime)s] [Agent] %(message)s", datefmt="%H:%M:%S"))
logger.addHandler(console_handler)

# ファイルハンドラ（日付別ファイル）
if ENABLE_FILE_LOG:
    today = datetime.now().strftime("%Y-%m-%d")
    log_file = LOG_DIR / f"assistant-agent-{today}.log"
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
TTS_VOICE = os.environ.get("TTS_VOICE", "ja-JP-NanamiNeural")
TTS_ENABLED = os.environ.get("TTS_ENABLED", "true").lower() == "true"

# HTTPサーバー設定 (後方互換: 旧WS_*変数もサポート)
HTTP_HOST = os.environ.get("ASSISTANT_HOST", os.environ.get("ASSISTANT_WS_HOST", "localhost"))
HTTP_PORT = int(os.environ.get("ASSISTANT_PORT", os.environ.get("ASSISTANT_WS_PORT", "9321")))

# MCP設定
MCP_CONFIG_PATH = Path(os.environ.get("MCP_CONFIG_PATH", Path(__file__).parent / "mcp_config.json"))

# Agent SDK設定
MAX_TURNS = int(os.environ.get("AGENT_MAX_TURNS", "10"))
SESSION_DB_PATH = Path(os.environ.get("AGENT_SESSION_DB", Path(__file__).parent / "sessions.db"))

# ウェイクワードリスト
WAKE_WORDS_STR = os.environ.get("WAKE_WORDS", "OKガーコ,okガーコ,オーケーガーコ,ガーコちゃん")
WAKE_WORDS = [w.strip() for w in WAKE_WORDS_STR.split(",")]

# stream_server設定（TTS音声のWebRTC配信用）
STREAM_SERVER_URL = os.environ.get("STREAM_SERVER_URL", "http://localhost:9320")

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
        logger.debug(f"[DEBUG] {msg}")
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


# ========== MCP サーバー読み込み ==========

# 重複ツール名のフィルタリング
# memory サーバーの list_directory は filesystem の list_directory と重複するため除外
DUPLICATE_TOOLS_FILTER = {
    "memory": {"list_directory"},  # memory_list_directory は filesystem_list_directory と同じ機能を提供
}


def create_tool_filter(server_name: str):
    """サーバー固有のツールフィルターを作成（重複ツールを除外）"""
    from agents.mcp import create_static_tool_filter

    excluded_tools = DUPLICATE_TOOLS_FILTER.get(server_name, set())
    if not excluded_tools:
        return None

    # SDK提供の静的フィルターを使用
    return create_static_tool_filter(blocked_tool_names=list(excluded_tools))


def load_mcp_servers(config_path: Path) -> list:
    """mcp_config.jsonからMCPサーバーを動的に生成"""
    from agents.mcp import MCPServerStdio

    if not config_path.exists():
        log(f"MCP設定ファイルなし: {config_path}")
        return []

    try:
        config_text = config_path.read_text(encoding="utf-8")
        config = json.loads(config_text)
    except Exception as e:
        log(f"MCP設定読み込みエラー: {e}", level="error")
        return []

    servers = []
    for name, server_config in config.get("mcpServers", {}).items():
        command = server_config.get("command")
        args = server_config.get("args", [])
        env = server_config.get("env", {})

        if not command:
            log(f"MCPサーバー '{name}' にcommandがありません", level="warning")
            continue

        # 環境変数を展開（${VAR} → os.environ[VAR]）
        expanded_env = {}
        for k, v in env.items():
            if isinstance(v, str) and v.startswith("${") and v.endswith("}"):
                var_name = v[2:-1]
                expanded_env[k] = os.environ.get(var_name, "")
            else:
                expanded_env[k] = v

        # 現在の環境変数と結合
        full_env = {**os.environ, **expanded_env}

        # ツールフィルターを取得（重複ツールを除外）
        tool_filter = create_tool_filter(name)

        server = MCPServerStdio(
            name=name,
            params={
                "command": command,
                "args": args,
                "env": full_env,
            },
            cache_tools_list=True,
            tool_filter=tool_filter,
        )
        servers.append(server)
        log(f"  MCP: {name} ({command})")

    return servers


# ========== Agent Hooks（ツール呼び出しのログ記録） ==========

def create_logging_hooks():
    """ツール呼び出しをログに記録するAgentHooksを作成"""
    from agents.lifecycle import AgentHooks

    class LoggingAgentHooks(AgentHooks):
        """ツール呼び出しをログに記録するAgentHooks"""

        async def on_tool_start(self, context, agent, tool) -> None:
            """ツール実行開始時"""
            tool_name = tool.name if hasattr(tool, 'name') else str(tool)
            log(f"ツール実行開始: {tool_name}")

        async def on_tool_end(self, context, agent, tool, result) -> None:
            """ツール実行完了時"""
            tool_name = tool.name if hasattr(tool, 'name') else str(tool)
            # 結果を文字列に変換
            if isinstance(result, dict):
                if DEBUG_VERBOSE:
                    result_str = json.dumps(result, ensure_ascii=False, indent=2)
                else:
                    result_str = json.dumps(result, ensure_ascii=False, separators=(',', ':'))
            else:
                result_str = str(result)

            if DEBUG_VERBOSE:
                # 全文表示
                log(f"ツール完了: {tool_name}", level="debug")
                log(f"  結果:\n{result_str}", level="debug")
            else:
                # 短縮表示（1行、80文字制限）
                result_oneline = result_str.replace('\n', ' ').strip()
                if len(result_oneline) > 80:
                    result_oneline = result_oneline[:80] + "…"
                log(f"ツール完了: {tool_name} -> {result_oneline}", level="debug")

    return LoggingAgentHooks()


# ========== Agent Assistant ==========

class AgentAssistant:
    """OpenAI Agent SDK統合AIアシスタント"""

    def __init__(self, config_path: Path = MCP_CONFIG_PATH):
        self.config_path = config_path
        self.manager = None
        self.agent = None
        self.tool_count = 0
        self.tool_names = []

    async def start(self):
        """アシスタントを起動"""
        from agents import Agent
        from agents.mcp import MCPServerManager

        log("AgentAssistant 起動中...")

        # OpenAI APIキー確認
        if not OPENAI_API_KEY:
            log("警告: OPENAI_API_KEY が設定されていません", level="warning")

        # MCPサーバー読み込み
        servers = load_mcp_servers(self.config_path)

        if servers:
            # MCPServerManagerで接続管理
            self.manager = MCPServerManager(
                servers,
                drop_failed_servers=True,
            )
            await self.manager.__aenter__()

            # 接続結果をログ
            active_count = len(self.manager.active_servers)
            failed_count = len(self.manager.failed_servers)
            if failed_count > 0:
                log(f"MCP: {active_count}個接続, {failed_count}個失敗", level="warning")
                for name, error in self.manager.errors.items():
                    log(f"  失敗: {name} - {error}", level="warning")
            else:
                log(f"MCP: {active_count}個のサーバー接続")

            # ツール一覧を取得
            for server in self.manager.active_servers:
                try:
                    tools = await server.list_tools()
                    for tool in tools:
                        tool_name = tool.name if hasattr(tool, 'name') else str(tool)
                        self.tool_names.append(tool_name)
                except Exception as e:
                    log(f"ツール一覧取得エラー: {e}", level="debug")

            self.tool_count = len(self.tool_names)
            log(f"利用可能ツール: {self.tool_count}個")
            for name in self.tool_names:
                log(f"  - {name}")

            # Agent作成（hooksでツール呼び出しをログ）
            self.agent = Agent(
                name="Garko",
                instructions=load_system_prompt(),
                mcp_servers=self.manager.active_servers,
                model=AI_MODEL,
                hooks=create_logging_hooks(),
            )
        else:
            # MCPサーバーなしでAgent作成
            self.agent = Agent(
                name="Garko",
                instructions=load_system_prompt(),
                model=AI_MODEL,
                hooks=create_logging_hooks(),
            )

        log(f"AgentAssistant 準備完了 (ツール: {self.tool_count}個)")

    async def stop(self):
        """アシスタントを停止"""
        if self.manager:
            try:
                await self.manager.__aexit__(None, None, None)
            except Exception:
                pass
        log("AgentAssistant 停止")

    async def process_query(self, query: str, session_id: str = "default") -> str:
        """クエリを処理して応答を生成"""
        from agents import Runner, SQLiteSession

        if not self.agent:
            return "エージェントが初期化されていません"

        # 履歴クリアコマンド
        if query.strip() in ["リセット", "クリア", "会話をクリア", "履歴クリア", "reset", "clear"]:
            session = SQLiteSession(session_id, str(SESSION_DB_PATH))
            await session.clear_session()
            log("会話履歴をクリアしました")
            return "会話履歴をクリアしました。"

        log(f"クエリ処理: {query} (session={session_id})")

        try:
            # セッション作成（SQLite永続化）
            session = SQLiteSession(session_id, str(SESSION_DB_PATH))

            # Agentを実行
            result = await Runner.run(
                self.agent,
                query,
                session=session,
                max_turns=MAX_TURNS,
            )

            response_text = result.final_output or ""
            log(f"応答生成完了: {response_text[:50]}...")
            log(f"応答全文: {response_text}", level="debug")

            return response_text

        except Exception as e:
            log(f"エラー: {e}", level="error")
            # MaxTurnsExceeded の場合
            if "MaxTurns" in str(type(e).__name__):
                return "処理が複雑すぎます。もう少し簡単な質問をしてください。"
            return f"エラーが発生しました: {e}"

    async def process_query_streamed(self, query: str, session_id: str = "default"):
        """クエリを処理してストリーミングイベントを生成 (async generator)"""
        from agents import Runner, SQLiteSession
        from openai.types.responses import ResponseTextDeltaEvent

        if not self.agent:
            yield {"type": "error", "message": "エージェントが初期化されていません"}
            return

        # 履歴クリアコマンド
        if query.strip() in ["リセット", "クリア", "会話をクリア", "履歴クリア", "reset", "clear"]:
            session = SQLiteSession(session_id, str(SESSION_DB_PATH))
            await session.clear_session()
            log("会話履歴をクリアしました")
            yield {"type": "done", "response": "会話履歴をクリアしました。"}
            return

        log(f"クエリ処理(stream): {query} (session={session_id})")

        # 処理開始を通知
        yield {"type": "thinking"}

        try:
            # セッション作成（SQLite永続化）
            session = SQLiteSession(session_id, str(SESSION_DB_PATH))

            # Agentをストリーミングモードで実行
            result = Runner.run_streamed(
                self.agent,
                query,
                session=session,
                max_turns=MAX_TURNS,
            )

            final_text = ""

            async for event in result.stream_events():
                if event.type == "run_item_stream_event":
                    # ツール呼び出しイベント
                    if event.name == "tool_called":
                        tool_name = ""
                        if hasattr(event.item, 'raw_item') and hasattr(event.item.raw_item, 'name'):
                            tool_name = event.item.raw_item.name
                        elif hasattr(event.item, 'name'):
                            tool_name = event.item.name
                        log(f"ストリーム: ツール開始 - {tool_name}")
                        yield {"type": "tool_start", "name": tool_name}

                    elif event.name == "tool_output":
                        tool_name = ""
                        if hasattr(event.item, 'raw_item') and hasattr(event.item.raw_item, 'call_id'):
                            # ツール名は call_id から推測できないので空
                            pass
                        log(f"ストリーム: ツール完了 - {tool_name}")
                        yield {"type": "tool_end", "name": tool_name}

                    elif event.name == "message_output_created":
                        # メッセージ出力完了（最終応答はここで取得）
                        if hasattr(event.item, 'raw_item'):
                            raw_item = event.item.raw_item
                            if hasattr(raw_item, 'content') and raw_item.content:
                                for content_item in raw_item.content:
                                    if hasattr(content_item, 'text'):
                                        final_text = content_item.text
                                        break

                elif event.type == "raw_response_event":
                    # テキストデルタイベント（トークン単位）
                    if isinstance(event.data, ResponseTextDeltaEvent):
                        delta = event.data.delta
                        if delta:
                            yield {"type": "text", "delta": delta}

            # 最終応答を取得（stream_events()完了後にfinal_outputが利用可能）
            response_text = result.final_output or final_text or ""

            log(f"ストリーム完了: {response_text[:50]}...")
            yield {"type": "done", "response": response_text}

        except Exception as e:
            log(f"ストリームエラー: {e}", level="error")
            # MaxTurnsExceeded の場合
            if "MaxTurns" in str(type(e).__name__):
                yield {"type": "done", "response": "処理が複雑すぎます。もう少し簡単な質問をしてください。"}
            else:
                yield {"type": "error", "message": str(e)}


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


# TTS再生プロセス管理
_tts_process = None
_tts_audio_path = None


async def play_audio_async(audio_path: Path) -> bool:
    """音声ファイルを非同期で再生"""
    global _tts_process, _tts_audio_path
    try:
        _tts_audio_path = audio_path
        _tts_process = await asyncio.create_subprocess_exec(
            "ffplay", "-nodisp", "-autoexit", "-loglevel", "error", str(audio_path),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL
        )
        await _tts_process.wait()
        _tts_process = None
        return True
    except Exception as e:
        log(f"再生エラー: {e}")
        _tts_process = None
        return False


async def send_tts_to_client(audio_path: Path, client_id: str) -> bool:
    """TTS音声をOpusに変換してstream_serverに送信し、WebRTC経由でクライアントに配信"""
    import aiohttp

    if not client_id:
        log("client_id未指定、WebRTC配信をスキップ")
        return False

    try:
        # FFmpegでMP3をOpusに変換（20msフレーム）
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", str(audio_path),
            "-ac", "1",
            "-ar", "48000",
            "-c:a", "libopus",
            "-b:a", "24k",
            "-frame_duration", "20",
            "-application", "voip",
            "-f", "ogg",
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        stdout, stderr = await process.communicate()

        if process.returncode != 0:
            log(f"Opus変換エラー: {stderr.decode()}", level="error")
            return False

        # OGGストリームからOpusフレームを抽出して送信
        ogg_data = stdout
        log(f"Opus変換完了: {len(ogg_data)} bytes")
        pos = 0
        headers_skipped = 0

        # 全Opusフレームを先に抽出
        opus_frames = []
        while pos < len(ogg_data):
            if pos + 27 > len(ogg_data):
                break
            if ogg_data[pos:pos+4] != b'OggS':
                pos += 1
                continue

            num_segments = ogg_data[pos + 26]
            if pos + 27 + num_segments > len(ogg_data):
                break

            segment_table = ogg_data[pos + 27:pos + 27 + num_segments]
            payload_size = sum(segment_table)
            page_size = 27 + num_segments + payload_size

            if pos + page_size > len(ogg_data):
                break

            payload_start = pos + 27 + num_segments

            packet_data = bytearray()
            segment_offset = 0
            for seg_size in segment_table:
                packet_data.extend(ogg_data[payload_start + segment_offset:payload_start + segment_offset + seg_size])
                segment_offset += seg_size

                if seg_size < 255:
                    if len(packet_data) > 0:
                        if packet_data[:8] == b'OpusHead' or packet_data[:8] == b'OpusTags':
                            headers_skipped += 1
                        else:
                            opus_frames.append(bytes(packet_data))
                    packet_data = bytearray()

            pos += page_size

        log(f"OGG解析: {len(opus_frames)}フレーム抽出, {headers_skipped}ヘッダースキップ")

        if len(opus_frames) == 0:
            log(f"TTS: Opusフレームが見つかりません", level="warning")
            return False

        # 全フレームを一括送信
        batch_data = bytearray()
        for opus_frame in opus_frames:
            frame_len = len(opus_frame)
            batch_data.extend(frame_len.to_bytes(2, 'big'))
            batch_data.extend(opus_frame)

        async with aiohttp.ClientSession() as session:
            try:
                async with session.post(
                    f"{STREAM_SERVER_URL}/api/tts_audio",
                    data=bytes(batch_data),
                    headers={
                        "Content-Type": "application/octet-stream",
                        "X-Target-Client": client_id,
                        "X-Frame-Count": str(len(opus_frames))
                    },
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as resp:
                    if resp.status == 200:
                        log(f"TTS WebRTC配信開始: {len(opus_frames)}フレーム -> {client_id}")
                        return True
                    else:
                        log(f"TTS送信エラー: HTTP {resp.status}", level="error")
                        return False
            except Exception as e:
                log(f"TTS送信エラー: {e}", level="error")
                return False

    except Exception as e:
        log(f"TTS WebRTC配信エラー: {e}", level="error")
        return False


def stop_audio() -> bool:
    """再生中の音声を停止"""
    global _tts_process, _tts_audio_path
    if _tts_process is not None:
        try:
            _tts_process.terminate()
            _tts_process = None
            log("TTS再生を停止しました")
            if _tts_audio_path:
                audio_path = _tts_audio_path
                _tts_audio_path = None
                def delayed_delete():
                    import time as t
                    t.sleep(0.5)
                    try:
                        if audio_path.exists():
                            audio_path.unlink(missing_ok=True)
                    except Exception:
                        pass
                import threading
                threading.Thread(target=delayed_delete, daemon=True).start()
            return True
        except Exception as e:
            log(f"TTS停止エラー: {e}", level="error")
            return False
    return False


# ========== HTTP サービス ==========

class AssistantService:
    """HTTPサービス (aiohttp)"""

    def __init__(self, host: str = HTTP_HOST, port: int = HTTP_PORT):
        self.host = host
        self.port = port
        self.assistant = AgentAssistant()
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

        # クライアントID（TTS音声のWebRTC配信先）
        client_id = data.get("client_id")

        # セッションID（会話の識別子、デフォルトはclient_idまたは"default"）
        session_id = data.get("session_id", client_id or "default")

        # TTSモード: server（サーバーTTS）, client（端末TTS）, none（音声なし）
        tts_mode = data.get("tts_mode", "server")

        # ウェイクワードチェック
        if data.get("check_wake_word", False):
            query = check_wake_word(query)
            if not query:
                return web.json_response({"skipped": True, "reason": "No wake word"})

        log(f"クエリ受信: {query[:50]}..." + (f" (client={client_id}, session={session_id}, tts={tts_mode})" if client_id else ""))

        # クエリ処理
        response_text = await self.assistant.process_query(query, session_id)

        # TTS生成・再生（バックグラウンドで実行）
        if TTS_ENABLED and tts_mode == "server":
            asyncio.create_task(self._play_tts(response_text, client_id))

        return web.json_response({"response": response_text})

    async def _play_tts(self, text: str, client_id: str | None = None):
        """TTSをバックグラウンドで再生"""
        try:
            audio_path = await text_to_speech(text)
            if audio_path:
                play_task = asyncio.create_task(play_audio_async(audio_path))

                if client_id:
                    await send_tts_to_client(audio_path, client_id)

                await play_task

                if audio_path.exists():
                    audio_path.unlink(missing_ok=True)
        except Exception as e:
            log(f"TTS再生エラー: {e}", level="error")

    async def handle_status(self, request):
        """GET /status - ステータス取得"""
        from aiohttp import web

        return web.json_response({
            "status": "running",
            "version": "agent-sdk",
            "tools": self.assistant.tool_count,
            "tool_names": self.assistant.tool_names,
            "model": AI_MODEL,
            "max_turns": MAX_TURNS,
        })

    async def handle_stop_tts(self, request):
        """POST /stop_tts - TTS再生停止"""
        from aiohttp import web

        stopped = stop_audio()
        return web.json_response({"stopped": stopped})

    async def handle_query_stream(self, request):
        """POST /query_stream - SSEストリーミングクエリ処理"""
        from aiohttp import web

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        query = data.get("query", "")
        if not query:
            return web.json_response({"error": "Empty query"}, status=400)

        # クライアントID（TTS音声のWebRTC配信先）
        client_id = data.get("client_id")

        # セッションID（会話の識別子、デフォルトはclient_idまたは"default"）
        session_id = data.get("session_id", client_id or "default")

        # TTSモード: server（サーバーTTS）, client（端末TTS）, none（音声なし）
        tts_mode = data.get("tts_mode", "server")

        # ウェイクワードチェック
        if data.get("check_wake_word", False):
            query = check_wake_word(query)
            if not query:
                return web.json_response({"skipped": True, "reason": "No wake word"})

        log(f"ストリームクエリ受信: {query[:50]}..." + (f" (client={client_id}, session={session_id}, tts={tts_mode})" if client_id else ""))

        # SSEレスポンスを準備
        response = web.StreamResponse(
            status=200,
            reason='OK',
            headers={
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',  # nginx向け
            }
        )
        await response.prepare(request)

        final_response = ""

        try:
            # ストリーミング処理
            async for event in self.assistant.process_query_streamed(query, session_id):
                event_data = json.dumps(event, ensure_ascii=False)
                await response.write(f"data: {event_data}\n\n".encode('utf-8'))

                # 最終応答を保存
                if event.get("type") == "done":
                    final_response = event.get("response", "")

            # TTS生成・再生（バックグラウンドで実行）
            if TTS_ENABLED and tts_mode == "server" and final_response:
                asyncio.create_task(self._play_tts(final_response, client_id))

        except Exception as e:
            log(f"ストリームエラー: {e}", level="error")
            error_event = json.dumps({"type": "error", "message": str(e)}, ensure_ascii=False)
            await response.write(f"data: {error_event}\n\n".encode('utf-8'))

        await response.write_eof()
        return response

    async def start(self):
        """サービスを起動"""
        from aiohttp import web

        print("=" * 50)
        print("  AI音声アシスタント (Agent SDK)")
        print("=" * 50)
        print(f"  モデル: {AI_MODEL}")
        print(f"  TTSボイス: {TTS_VOICE}")
        print(f"  ウェイクワード: {WAKE_WORDS}")
        print(f"  最大ターン: {MAX_TURNS}")
        print(f"  セッションDB: {SESSION_DB_PATH}")
        print(f"  HTTP: http://{self.host}:{self.port}")
        print()

        # AgentAssistant起動
        await self.assistant.start()
        print()

        # HTTPサーバー起動
        app = web.Application()
        app.router.add_post('/query', self.handle_query)
        app.router.add_post('/query_stream', self.handle_query_stream)  # SSEストリーミング
        app.router.add_post('/stop_tts', self.handle_stop_tts)
        app.router.add_get('/status', self.handle_status)

        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, self.host, self.port)
        await site.start()

        log(f"サービス起動完了 - http://{self.host}:{self.port}")
        print("  Ctrl+C で終了")
        print()

        try:
            await asyncio.Future()
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
