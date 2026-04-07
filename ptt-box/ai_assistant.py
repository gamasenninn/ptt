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
import re
import asyncio
import tempfile
import subprocess
import logging
import time
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
AI_MODEL = os.environ.get("AI_MODEL", "gpt-5.4-mini")
AI_RESPONSE_MAX_TOKENS = int(os.environ.get("AI_RESPONSE_MAX_TOKENS", "500"))

# 会話履歴設定
HISTORY_SIZE = int(os.environ.get("ASSISTANT_HISTORY_SIZE", "10"))  # 保持する会話ペア数
SESSION_TIMEOUT = int(os.environ.get("ASSISTANT_SESSION_TIMEOUT", "300"))  # セッションタイムアウト（秒）
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

# stream_server設定（TTS音声のWebRTC配信用）
STREAM_SERVER_URL = os.environ.get("STREAM_SERVER_URL", "http://localhost:9320")
HEARTBEAT_INTERVAL = 30  # ハートビート送信間隔（秒）

# システムプロンプト（外部ファイルから読み込み）
SYSTEM_PROMPT_PATH = Path(os.environ.get("SYSTEM_PROMPT_PATH", Path(__file__).parent / "ASSISTANT.md"))

def load_system_prompt() -> str:
    """システムプロンプトを外部ファイルから読み込む
    ASSISTANT.md（共通） + ASSISTANT.local.md（環境固有）をマージ
    """
    if SYSTEM_PROMPT_PATH.exists():
        prompt = SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    else:
        prompt = "あなたはAIアシスタントです。簡潔に応答してください。"

    # ローカル追加プロンプト（環境固有の設定）
    local_path = SYSTEM_PROMPT_PATH.parent / "ASSISTANT.local.md"
    if local_path.exists():
        local_text = local_path.read_text(encoding="utf-8").strip()
        if local_text:
            prompt = prompt.rstrip() + "\n\n" + local_text

    return prompt


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
        # 会話履歴
        self.conversation_history: list[dict] = []
        self.last_interaction: float = 0

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
            import re

            with open(self.config_path, "r", encoding="utf-8") as f:
                config_text = f.read()

            # 環境変数を展開 (${VAR_NAME} 形式)
            def expand_env_vars(text: str) -> str:
                def replacer(match):
                    var_name = match.group(1)
                    return os.environ.get(var_name, "")
                return re.sub(r'\$\{(\w+)\}', replacer, text)

            config_text = expand_env_vars(config_text)
            config = json.loads(config_text)

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

    def clear_history(self) -> None:
        """会話履歴をクリア"""
        self.conversation_history = []
        self.last_interaction = 0
        log("会話履歴をクリアしました")

    async def process_query(self, query: str) -> str:
        """クエリを処理して応答を生成"""
        if not self.openai_client:
            return "OpenAI APIが設定されていません"

        # 履歴クリアコマンド
        if query.strip() in ["リセット", "クリア", "会話をクリア", "履歴クリア", "reset", "clear"]:
            self.clear_history()
            return "会話履歴をクリアしました。"

        # セッションタイムアウトチェック
        now = time.time()
        if self.last_interaction > 0 and (now - self.last_interaction) > SESSION_TIMEOUT:
            log(f"セッションタイムアウト ({SESSION_TIMEOUT}秒経過) - 履歴クリア")
            self.conversation_history = []

        log(f"クエリ処理: {query}")
        log(f"クエリ詳細: model={AI_MODEL}, max_tokens={AI_RESPONSE_MAX_TOKENS}, history={len(self.conversation_history)}件", level="debug")

        # メッセージ構築（システムプロンプト + 会話履歴 + 今回のクエリ）
        messages = [
            {"role": "system", "content": load_system_prompt()}
        ]
        messages.extend(self.conversation_history)
        messages.append({"role": "user", "content": query})

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

                    # 会話履歴に追加
                    self.conversation_history.append({"role": "user", "content": query})
                    self.conversation_history.append({"role": "assistant", "content": result})

                    # 履歴サイズ制限（古いものを削除）
                    max_messages = HISTORY_SIZE * 2  # user + assistant で1ペア
                    if len(self.conversation_history) > max_messages:
                        removed_count = len(self.conversation_history) - max_messages
                        self.conversation_history = self.conversation_history[-max_messages:]
                        log(f"履歴トリム: {removed_count // 2}ペア削除 → {HISTORY_SIZE}ペア保持")

                    # タイムスタンプ更新
                    self.last_interaction = now

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

def clean_text_for_tts(text: str) -> str:
    """TTS用にテキストからマークダウン記号・URLを除去"""
    # マークダウンリンク [text](url) → text
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    # 裸のURL
    text = re.sub(r'https?://\S+', '', text)
    # 見出し記号 (### text → text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    # 太字・斜体 (**text** or *text* → text)
    text = re.sub(r'\*{1,2}([^*]+)\*{1,2}', r'\1', text)
    # リスト記号 (- text → text)
    text = re.sub(r'^\s*[-*+]\s+', '', text, flags=re.MULTILINE)
    # 番号リスト (1. text → text)
    text = re.sub(r'^\s*\d+\.\s+', '', text, flags=re.MULTILINE)
    # インラインコード (`code` → code)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # マークダウンテーブル区切り線 (|---|---|)
    text = re.sub(r'^\s*\|?[\s\-:]+(\|[\s\-:]+)+\|?\s*$', '', text, flags=re.MULTILINE)
    # テーブルのパイプ記号
    text = re.sub(r'\|', ' ', text)
    # 連続空白を整理
    text = re.sub(r'  +', ' ', text)
    return text.strip()


async def text_to_speech(text: str) -> Path | None:
    """edge-ttsで音声合成"""
    if not TTS_ENABLED:
        return None

    text = clean_text_for_tts(text)
    if not text:
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
        await _tts_process.wait()  # 非同期で再生完了まで待機
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
            "-ac", "1",           # モノラル
            "-ar", "48000",       # 48kHz
            "-c:a", "libopus",
            "-b:a", "24k",        # 24kbps
            "-frame_duration", "20",  # 20msフレーム
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
        frame_count = 0
        headers_skipped = 0

        # 全Opusフレームを先に抽出（OGGページのセグメントテーブルを正しく解析）
        opus_frames = []
        while pos < len(ogg_data):
            # OGGページヘッダーを解析
            if pos + 27 > len(ogg_data):
                break
            if ogg_data[pos:pos+4] != b'OggS':
                pos += 1
                continue

            num_segments = ogg_data[pos + 26]
            if pos + 27 + num_segments > len(ogg_data):
                break

            # セグメントテーブルを読み取り
            segment_table = ogg_data[pos + 27:pos + 27 + num_segments]
            payload_size = sum(segment_table)
            page_size = 27 + num_segments + payload_size

            if pos + page_size > len(ogg_data):
                break

            # ペイロード開始位置
            payload_start = pos + 27 + num_segments

            # セグメントテーブルに従って個々のパケットを抽出
            # 255バイトセグメントは継続を意味し、<255で終端
            packet_data = bytearray()
            segment_offset = 0
            for seg_size in segment_table:
                packet_data.extend(ogg_data[payload_start + segment_offset:payload_start + segment_offset + seg_size])
                segment_offset += seg_size

                if seg_size < 255:
                    # パケット終端
                    if len(packet_data) > 0:
                        # OpusHead/OpusTags ヘッダーをスキップ
                        if packet_data[:8] == b'OpusHead' or packet_data[:8] == b'OpusTags':
                            headers_skipped += 1
                        else:
                            opus_frames.append(bytes(packet_data))
                    packet_data = bytearray()

            pos += page_size

        log(f"OGG解析: {len(opus_frames)}フレーム抽出, {headers_skipped}ヘッダースキップ")

        if len(opus_frames) == 0:
            log(f"TTS: Opusフレームが見つかりません (data={len(ogg_data)}B, headers={headers_skipped})", level="warning")
            return False

        # 全フレームを一括送信（長さプレフィックス形式）
        # フォーマット: [2バイト長さ][フレームデータ][2バイト長さ][フレームデータ]...
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
            # 一時ファイルを削除（プロセス終了を少し待つ）
            if _tts_audio_path:
                audio_path = _tts_audio_path
                _tts_audio_path = None
                # 別スレッドで遅延削除（ファイルロック解放待ち）
                def delayed_delete():
                    import time as t
                    t.sleep(0.5)
                    try:
                        if audio_path.exists():
                            audio_path.unlink(missing_ok=True)
                    except Exception:
                        pass  # 削除失敗は無視（tempファイルなので問題なし）
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
        self.assistant = MCPAssistant()
        self.runner = None
        self._heartbeat_task = None

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

        # TTSモード: server（サーバーTTS）, client（端末TTS）, none（音声なし）
        tts_mode = data.get("tts_mode", "server")

        # ウェイクワードチェック
        if data.get("check_wake_word", False):
            query = check_wake_word(query)
            if not query:
                return web.json_response({"skipped": True, "reason": "No wake word"})

        log(f"クエリ受信: {query[:50]}..." + (f" (client={client_id}, tts={tts_mode})" if client_id else ""))

        # クエリ処理
        response_text = await self.assistant.process_query(query)

        # TTS生成・再生（バックグラウンドで実行、レスポンスを先に返す）
        # tts_mode が 'server' の場合のみサーバー側でTTS生成
        if TTS_ENABLED and tts_mode == "server":
            asyncio.create_task(self._play_tts(response_text, client_id))

        return web.json_response({"response": response_text})

    async def _play_tts(self, text: str, client_id: str | None = None):
        """TTSをバックグラウンドで再生"""
        try:
            audio_path = await text_to_speech(text)
            if audio_path:
                # サーバーのスピーカーで再生（従来通り）
                play_task = asyncio.create_task(play_audio_async(audio_path))

                # WebRTC経由でクライアントにも配信
                if client_id:
                    await send_tts_to_client(audio_path, client_id)

                # ローカル再生完了を待機
                await play_task

                # 正常終了時のみファイル削除（stop_audioで停止した場合はそちらで削除）
                if audio_path.exists():
                    audio_path.unlink(missing_ok=True)
        except Exception as e:
            log(f"TTS再生エラー: {e}", level="error")

    async def handle_status(self, request):
        """GET /status - ステータス取得"""
        from aiohttp import web

        # セッション残り時間計算
        session_remaining = None
        if self.assistant.last_interaction > 0:
            elapsed = time.time() - self.assistant.last_interaction
            remaining = SESSION_TIMEOUT - elapsed
            session_remaining = max(0, int(remaining))

        return web.json_response({
            "status": "running",
            "tools": len(self.assistant.tools),
            "tool_names": [t.name if hasattr(t, 'name') else t.get('name') for t in self.assistant.tools],
            "conversation_history_size": len(self.assistant.conversation_history) // 2,  # ペア数
            "session_remaining_seconds": session_remaining
        })

    async def handle_stop_tts(self, request):
        """POST /stop_tts - TTS再生停止"""
        from aiohttp import web

        stopped = stop_audio()
        return web.json_response({"stopped": stopped})

    async def start(self):
        """サービスを起動"""
        from aiohttp import web

        print("=" * 50)
        print("  AI音声アシスタント (HTTP)")
        print("=" * 50)
        print(f"  モデル: {AI_MODEL}")
        print(f"  TTSボイス: {TTS_VOICE}")
        print(f"  ウェイクワード: {WAKE_WORDS}")
        print(f"  履歴保持: {HISTORY_SIZE}ペア")
        print(f"  セッションタイムアウト: {SESSION_TIMEOUT}秒")
        print(f"  HTTP: http://{self.host}:{self.port}")
        print()

        # MCPアシスタント起動
        await self.assistant.start()
        print()

        # HTTPサーバー起動
        app = web.Application()
        app.router.add_post('/query', self.handle_query)
        app.router.add_post('/stop_tts', self.handle_stop_tts)
        app.router.add_get('/status', self.handle_status)

        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, self.host, self.port)
        await site.start()

        # ハートビート開始
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

        log(f"サービス起動完了 - http://{self.host}:{self.port}")
        print("  Ctrl+C で終了")
        print()

        try:
            await asyncio.Future()  # 永久待機
        except asyncio.CancelledError:
            pass
        finally:
            await self.stop()

    async def _heartbeat_loop(self):
        """定期的にハートビートを送信"""
        import aiohttp
        while True:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        f"{STREAM_SERVER_URL}/api/health/beat",
                        json={"service": "assistant"},
                        timeout=aiohttp.ClientTimeout(total=5)
                    ) as resp:
                        pass
            except Exception:
                pass
            await asyncio.sleep(HEARTBEAT_INTERVAL)

    async def stop(self):
        """サービスを停止"""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
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
