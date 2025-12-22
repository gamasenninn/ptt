"""
WebRTC Audio Streaming Server
PCマイク音声をリアルタイムでブラウザに配信

Usage:
    uv run python ptt-box/stream_server.py
"""

import os
import asyncio
import logging
import time
import uuid
import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from fractions import Fraction
from typing import Optional

import numpy as np
import sounddevice as sd
from dotenv import load_dotenv

from aiohttp import web, WSMsgType
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer, RTCIceCandidate, MediaStreamTrack
import av

# ログ設定
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# aioice/aiortcのログレベルを下げる（TURN relay-to-relay禁止エラー等を抑制）
logging.getLogger('aioice').setLevel(logging.WARNING)
logging.getLogger('aiortc').setLevel(logging.WARNING)

# asyncioの未取得例外を抑制
import sys
def exception_handler(loop, context):
    exception = context.get('exception')
    if exception:
        exc_type = str(type(exception))
        # TURN/STUN関連のタイムアウトや失敗は無視
        if any(x in exc_type for x in ['TransactionFailed', 'TransactionTimeout']):
            return
    # その他の例外は通常通り出力
    loop.default_exception_handler(context)

# 環境変数読み込み
load_dotenv()

DEVICE_INDEX = int(os.environ.get("STREAM_DEVICE_INDEX", "1"))
HOST = os.environ.get("STREAM_HOST", "0.0.0.0")
PORT = int(os.environ.get("STREAM_PORT", "8080"))
SAMPLE_RATE = int(os.environ.get("STREAM_SAMPLE_RATE", "48000"))

# TURN設定
TURN_SERVER = os.environ.get("TURN_SERVER", "")
TURN_USERNAME = os.environ.get("TURN_USERNAME", "")
TURN_PASSWORD = os.environ.get("TURN_PASSWORD", "")

# 定数
CHANNELS = 1
FRAME_DURATION = 0.020  # 20ms
SAMPLES_PER_FRAME = int(SAMPLE_RATE * FRAME_DURATION)

# PTT設定
PTT_TIMEOUT = float(os.environ.get("PTT_TIMEOUT", "30.0"))  # 最大送信時間

# クライアントHTMLのパス
CLIENT_DIR = Path(__file__).parent / "stream_client"

# 録音ファイルのパス
RECORDINGS_DIR = Path(os.environ.get("RECORDINGS_DIR", Path(__file__).parent / "recordings"))
HISTORY_DIR = RECORDINGS_DIR / "history"


# ========== PTT管理 ==========

@dataclass
class ClientConnection:
    """クライアント接続情報"""
    client_id: str
    websocket: web.WebSocketResponse
    peer_connection: Optional[RTCPeerConnection] = None
    remote_audio_track: Optional[MediaStreamTrack] = None
    display_name: str = "Anonymous"
    connected_at: float = field(default_factory=time.time)
    is_monitor: bool = False  # モニタークライアント識別


class PTTManager:
    """PTT送信権管理"""

    def __init__(self):
        self.current_speaker: Optional[str] = None  # client_id or "pc_mic"
        self.speaker_start_time: Optional[float] = None
        self.max_transmit_time = PTT_TIMEOUT
        self.clients: dict[str, ClientConnection] = {}

    def request_floor(self, client_id: str) -> bool:
        """送信権を要求。成功したらTrue"""
        if self.current_speaker is None:
            self.current_speaker = client_id
            self.speaker_start_time = time.time()
            logger.info(f"PTT floor granted to {client_id}")
            return True
        logger.info(f"PTT floor denied to {client_id} (current: {self.current_speaker})")
        return False

    def release_floor(self, client_id: str) -> bool:
        """送信権を解放。成功したらTrue"""
        if self.current_speaker == client_id:
            logger.info(f"PTT floor released by {client_id}")
            self.current_speaker = None
            self.speaker_start_time = None
            return True
        return False

    def check_timeout(self) -> Optional[str]:
        """タイムアウトチェック。タイムアウトしたらclient_idを返す"""
        if self.current_speaker and self.speaker_start_time:
            elapsed = time.time() - self.speaker_start_time
            if elapsed > self.max_transmit_time:
                timed_out_speaker = self.current_speaker
                logger.info(f"PTT timeout for {timed_out_speaker} after {elapsed:.1f}s")
                self.current_speaker = None
                self.speaker_start_time = None
                return timed_out_speaker
        return None

    def get_speaker_name(self) -> Optional[str]:
        """現在の送信者の表示名を取得"""
        if self.current_speaker is None:
            return None
        if self.current_speaker == "pc_mic":
            return "PC Mic"
        client = self.clients.get(self.current_speaker)
        return client.display_name if client else self.current_speaker


class MicrophoneAudioTrack(MediaStreamTrack):
    """マイク入力をWebRTC音声トラックとして提供"""

    kind = "audio"

    def __init__(self, device_index: int, sample_rate: int = 48000):
        super().__init__()
        self._sample_rate = sample_rate
        self._samples_per_frame = int(sample_rate * FRAME_DURATION)
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._pts = 0
        self._loop = asyncio.get_event_loop()

        logger.info(f"Opening audio device {device_index} at {sample_rate}Hz")

        self._stream = sd.InputStream(
            device=device_index,
            samplerate=sample_rate,
            blocksize=self._samples_per_frame,
            channels=CHANNELS,
            dtype=np.int16,
            callback=self._audio_callback
        )
        self._stream.start()
        logger.info("Audio stream started")

    def _audio_callback(self, indata, frames, time_info, status):
        """音声コールバック（別スレッドで実行）"""
        if status:
            logger.warning(f"Audio callback status: {status}")

        try:
            data = indata.copy()
            self._loop.call_soon_threadsafe(self._put_nowait, data)
        except Exception as e:
            logger.error(f"Audio callback error: {e}")

    def _put_nowait(self, data):
        """キューにデータを追加（asyncioスレッドで実行）"""
        try:
            self._queue.put_nowait(data)
        except asyncio.QueueFull:
            pass  # バッファオーバーフロー時は破棄

    async def recv(self) -> av.AudioFrame:
        """次の音声フレームを返す"""
        data = await self._queue.get()

        # デバッグ: 最初の数フレームのみログ出力
        if self._pts < self._samples_per_frame * 5:
            rms = np.sqrt(np.mean(data.astype(np.float32)**2))
            logger.info(f"Audio frame: pts={self._pts}, samples={len(data)}, RMS={rms:.2f}")

        # av.AudioFrameを作成
        frame = av.AudioFrame.from_ndarray(
            data.T,  # shape変換: (samples, channels) → (channels, samples)
            format='s16',
            layout='mono'
        )
        frame.sample_rate = self._sample_rate
        frame.pts = self._pts
        frame.time_base = Fraction(1, self._sample_rate)

        self._pts += self._samples_per_frame

        return frame

    def stop(self):
        """ストリーム停止"""
        super().stop()
        if self._stream:
            self._stream.stop()
            self._stream.close()
            logger.info("Audio stream stopped")


class StreamServer:
    """HTTP + WebSocketサーバー"""

    def __init__(self):
        self.app = web.Application()
        self.pcs: set[RTCPeerConnection] = set()
        self.mic_tracks: list[MicrophoneAudioTrack] = []  # 各接続用のマイクトラック
        self.ptt_manager = PTTManager()  # PTT管理
        self.monitors: dict[str, ClientConnection] = {}  # モニタークライアント
        self.server_start_time = time.time()  # サーバー起動時刻

        # ICEサーバー設定
        self.ice_servers = [
            RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
        ]
        if TURN_SERVER and TURN_USERNAME and TURN_PASSWORD:
            # 複数のTURN URLを追加（UDP、TCP、TLS）
            turn_urls = [
                f"turn:{TURN_SERVER}?transport=udp",
                f"turn:{TURN_SERVER}?transport=tcp",
                f"turns:{TURN_SERVER}?transport=tcp",
            ]
            self.ice_servers.append(RTCIceServer(
                urls=turn_urls,
                username=TURN_USERNAME,
                credential=TURN_PASSWORD
            ))
            logger.info(f"TURN server configured: {TURN_SERVER}")

        # クライアント用ICE設定（JSON送信用）
        self.ice_servers_for_client = [
            {"urls": ["stun:stun.l.google.com:19302"]}
        ]
        if TURN_SERVER and TURN_USERNAME and TURN_PASSWORD:
            turn_urls = [
                f"turn:{TURN_SERVER}?transport=udp",
                f"turn:{TURN_SERVER}?transport=tcp",
                f"turns:{TURN_SERVER}?transport=tcp",
            ]
            self.ice_servers_for_client.append({
                "urls": turn_urls,
                "username": TURN_USERNAME,
                "credential": TURN_PASSWORD
            })

        # ルーティング設定
        self.app.router.add_get('/', self.handle_index)
        self.app.router.add_get('/ws', self.handle_websocket)
        self.app.router.add_get('/monitor', self.handle_monitor_page)
        self.app.router.add_get('/ws/monitor', self.handle_monitor_websocket)
        self.app.router.add_static('/js', CLIENT_DIR / 'js')

        # SRT API
        self.app.router.add_get('/api/srt/list', self.handle_srt_list)
        self.app.router.add_get('/api/srt/get', self.handle_srt_get)
        self.app.router.add_post('/api/srt/save', self.handle_srt_save)
        self.app.router.add_get('/api/audio', self.handle_audio)

        # シャットダウン時のクリーンアップ
        self.app.on_shutdown.append(self.on_shutdown)

    async def handle_index(self, request):
        """index.html配信"""
        return web.FileResponse(CLIENT_DIR / 'index.html')

    async def handle_monitor_page(self, request):
        """monitor.html配信"""
        return web.FileResponse(CLIENT_DIR / 'monitor.html')

    # ========== SRT API ==========

    def _extract_datetime_from_filename(self, filename: str) -> Optional[str]:
        """ファイル名から日時を抽出 (rec_YYYYMMDD_HHMMSS.srt -> YYYY-MM-DD HH:MM:SS)"""
        basename = Path(filename).stem
        match = re.match(r'rec_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})', basename)
        if match:
            return f"{match[1]}-{match[2]}-{match[3]} {match[4]}:{match[5]}:{match[6]}"
        return None

    def _format_short_datetime(self, datetime_str: Optional[str]) -> str:
        """日時を短縮フォーマット (MM/DD HH:MM)"""
        if not datetime_str:
            return "-"
        match = re.match(r'\d{4}-(\d{2})-(\d{2}) (\d{2}):(\d{2}):\d{2}', datetime_str)
        if match:
            return f"{match[1]}/{match[2]} {match[3]}:{match[4]}"
        return datetime_str

    def _parse_srt(self, content: str) -> list:
        """SRTファイルをパース"""
        if not content.strip():
            return []

        segments = []
        blocks = re.split(r'\n\n+', content.strip())

        for block in blocks:
            lines = block.strip().split('\n')
            if len(lines) < 3:
                continue

            # 1行目: インデックス番号
            try:
                index = int(lines[0])
            except ValueError:
                continue

            # 2行目: タイムスタンプ
            time_match = re.match(
                r'(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})',
                lines[1]
            )
            if not time_match:
                continue

            # 3行目以降: テキスト
            text = '\n'.join(lines[2:])

            segments.append({
                'index': index,
                'start': time_match[1],
                'end': time_match[2],
                'text': text
            })

        return segments

    def _get_preview(self, filename: str, max_length: int = 100) -> str:
        """SRTファイルのプレビューテキストを取得"""
        try:
            content = (RECORDINGS_DIR / filename).read_text(encoding='utf-8')
            segments = self._parse_srt(content)
            if not segments:
                return ""

            full_text = ' '.join(seg['text'] for seg in segments)
            if len(full_text) > max_length:
                return full_text[:max_length] + '...'
            return full_text
        except Exception:
            return ""

    async def handle_srt_list(self, request):
        """SRTファイル一覧"""
        try:
            files = []
            srt_files = sorted(RECORDINGS_DIR.glob('*.srt'), reverse=True)[:100]

            for srt_path in srt_files:
                filename = srt_path.name
                datetime_str = self._extract_datetime_from_filename(filename)
                wav_file = srt_path.stem + '.wav'

                files.append({
                    'filename': filename,
                    'datetime': datetime_str,
                    'datetimeShort': self._format_short_datetime(datetime_str),
                    'wavFile': wav_file,
                    'preview': self._get_preview(filename)
                })

            return web.json_response({'success': True, 'files': files})
        except Exception as e:
            return web.json_response({'success': False, 'error': str(e)}, status=400)

    async def handle_srt_get(self, request):
        """SRT内容取得"""
        try:
            filename = request.query.get('file', '')
            if not filename:
                raise ValueError('File parameter is required')

            # セキュリティ: ディレクトリトラバーサル防止
            filename = Path(filename).name
            srt_path = RECORDINGS_DIR / filename

            if not srt_path.exists():
                raise FileNotFoundError(f'File not found: {filename}')

            content = srt_path.read_text(encoding='utf-8')
            segments = self._parse_srt(content)
            wav_file = srt_path.stem + '.wav'

            return web.json_response({
                'success': True,
                'file': {
                    'filename': filename,
                    'datetime': self._extract_datetime_from_filename(filename),
                    'content': content,
                    'segments': segments,
                    'wavFile': wav_file
                }
            })
        except Exception as e:
            return web.json_response({'success': False, 'error': str(e)}, status=400)

    async def handle_srt_save(self, request):
        """SRT保存"""
        try:
            data = await request.json()
            filename = data.get('file', '')
            content = data.get('content', '')

            if not filename:
                raise ValueError('File parameter is required')
            if not content:
                raise ValueError('Content parameter is required')

            # セキュリティ: ディレクトリトラバーサル防止
            filename = Path(filename).name
            srt_path = RECORDINGS_DIR / filename

            # バックアップ作成
            if srt_path.exists():
                HISTORY_DIR.mkdir(parents=True, exist_ok=True)
                timestamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
                backup_path = HISTORY_DIR / f"{filename}.{timestamp}"
                shutil.copy2(srt_path, backup_path)

            # 保存
            srt_path.write_text(content, encoding='utf-8')

            return web.json_response({'success': True, 'message': 'Saved successfully'})
        except Exception as e:
            return web.json_response({'success': False, 'error': str(e)}, status=400)

    async def handle_audio(self, request):
        """WAVファイル配信（Range対応）"""
        try:
            filename = request.query.get('file', '')
            if not filename:
                raise ValueError('File parameter is required')

            # セキュリティ: ディレクトリトラバーサル防止、WAVファイルのみ許可
            filename = Path(filename).name
            if not re.match(r'^[\w\-]+\.wav$', filename, re.IGNORECASE):
                raise ValueError('Invalid file name')

            wav_path = RECORDINGS_DIR / filename
            if not wav_path.exists():
                raise FileNotFoundError('File not found')

            file_size = wav_path.stat().st_size

            # Range リクエスト対応
            range_header = request.headers.get('Range', '')
            if range_header:
                match = re.match(r'bytes=(\d+)-(\d*)', range_header)
                if match:
                    start = int(match[1])
                    end = int(match[2]) if match[2] else file_size - 1
                    length = end - start + 1

                    with open(wav_path, 'rb') as f:
                        f.seek(start)
                        data = f.read(length)

                    return web.Response(
                        body=data,
                        status=206,
                        headers={
                            'Content-Type': 'audio/wav',
                            'Content-Length': str(length),
                            'Content-Range': f'bytes {start}-{end}/{file_size}',
                            'Accept-Ranges': 'bytes'
                        }
                    )

            # 通常リクエスト
            return web.FileResponse(
                wav_path,
                headers={
                    'Content-Type': 'audio/wav',
                    'Accept-Ranges': 'bytes'
                }
            )
        except Exception as e:
            return web.Response(text=str(e), status=400)

    def get_monitor_state(self) -> dict:
        """モニター用のシステム状態を取得"""
        now = time.time()

        # クライアント情報
        clients = []
        for c in self.ptt_manager.clients.values():
            if c.is_monitor:
                continue  # モニタークライアントは除外

            client_info = {
                "clientId": c.client_id,
                "displayName": c.display_name,
                "connectedAt": c.connected_at,
                "duration": now - c.connected_at,
                "connectionState": c.peer_connection.connectionState if c.peer_connection else "unknown",
                "iceState": c.peer_connection.iceConnectionState if c.peer_connection else "unknown"
            }
            clients.append(client_info)

        # PTT状態
        ptt_state = {
            "state": "transmitting" if self.ptt_manager.current_speaker else "idle",
            "speaker": self.ptt_manager.current_speaker,
            "speakerName": self.ptt_manager.get_speaker_name(),
            "startTime": self.ptt_manager.speaker_start_time,
            "elapsed": (now - self.ptt_manager.speaker_start_time) if self.ptt_manager.speaker_start_time else 0,
            "maxTime": self.ptt_manager.max_transmit_time
        }

        # システム統計
        stats = {
            "totalClients": len([c for c in self.ptt_manager.clients.values() if not c.is_monitor]),
            "totalMonitors": len(self.monitors),
            "uptime": now - self.server_start_time
        }

        return {
            "type": "monitor_state",
            "timestamp": now,
            "clients": clients,
            "ptt": ptt_state,
            "stats": stats
        }

    async def handle_monitor_websocket(self, request):
        """モニター用WebSocketハンドラ"""
        ws = web.WebSocketResponse(heartbeat=30.0)
        await ws.prepare(request)

        # モニターID生成
        monitor_id = f"mon-{str(uuid.uuid4())[:6]}"
        monitor = ClientConnection(
            client_id=monitor_id,
            websocket=ws,
            display_name=f"Monitor-{monitor_id[-4:]}",
            is_monitor=True
        )
        self.monitors[monitor_id] = monitor

        logger.info(f"Monitor connected from {request.remote} (id: {monitor_id})")

        # RTCPeerConnection作成（音声受信用）
        config = RTCConfiguration(iceServers=self.ice_servers)
        pc = RTCPeerConnection(configuration=config)
        monitor.peer_connection = pc
        self.pcs.add(pc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info(f"Monitor {monitor_id} connection state: {pc.connectionState}")
            if pc.connectionState in ("failed", "closed"):
                await pc.close()
                self.pcs.discard(pc)

        @pc.on("icecandidate")
        async def on_icecandidate(candidate):
            if candidate:
                await ws.send_json({
                    "type": "ice-candidate",
                    "candidate": {
                        "candidate": candidate.candidate,
                        "sdpMid": candidate.sdpMid,
                        "sdpMLineIndex": candidate.sdpMLineIndex
                    }
                })

        # 初期設定送信
        await ws.send_json({
            "type": "config",
            "iceServers": self.ice_servers_for_client,
            "monitorId": monitor_id
        })

        # 初期状態送信
        await ws.send_json(self.get_monitor_state())

        # 状態定期配信タスク
        async def send_state_periodically():
            try:
                while not ws.closed:
                    await asyncio.sleep(1.0)
                    if not ws.closed:
                        await ws.send_json(self.get_monitor_state())
            except Exception:
                pass

        state_task = asyncio.create_task(send_state_periodically())

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    data = msg.json()

                    if data["type"] == "offer":
                        # モニターからのOffer（音声受信用）
                        offer = RTCSessionDescription(sdp=data["sdp"], type="offer")
                        await pc.setRemoteDescription(offer)

                        # マイクトラックを追加（モニターも音声を聴ける）
                        mic_track = MicrophoneAudioTrack(DEVICE_INDEX, SAMPLE_RATE)
                        self.mic_tracks.append(mic_track)
                        pc.addTrack(mic_track)

                        # Answer作成
                        answer = await pc.createAnswer()
                        await pc.setLocalDescription(answer)

                        # ICE gathering完了を待つ
                        while pc.iceGatheringState != "complete":
                            await asyncio.sleep(0.1)

                        await ws.send_json({
                            "type": "answer",
                            "sdp": pc.localDescription.sdp
                        })
                        logger.info(f"Monitor {monitor_id}: Answer sent")

                elif msg.type == WSMsgType.ERROR:
                    logger.error(f"Monitor WebSocket error: {ws.exception()}")

        except Exception as e:
            logger.error(f"Monitor WebSocket handler error: {e}")

        finally:
            state_task.cancel()
            self.monitors.pop(monitor_id, None)
            await pc.close()
            self.pcs.discard(pc)
            logger.info(f"Monitor disconnected (id: {monitor_id})")

        return ws

    async def broadcast_ptt_status(self):
        """全クライアントにPTT状態を通知"""
        status = {
            "type": "ptt_status",
            "state": "transmitting" if self.ptt_manager.current_speaker else "idle",
            "speaker": self.ptt_manager.current_speaker,
            "speakerName": self.ptt_manager.get_speaker_name()
        }
        for client in self.ptt_manager.clients.values():
            try:
                await client.websocket.send_json(status)
            except Exception:
                pass  # 切断済みクライアントは無視

    async def send_client_list(self, to_client_id: str):
        """指定クライアントに他クライアントのリストを送信"""
        client = self.ptt_manager.clients.get(to_client_id)
        if not client:
            return

        other_clients = [
            {"clientId": c.client_id, "displayName": c.display_name}
            for c in self.ptt_manager.clients.values()
            if c.client_id != to_client_id
        ]

        await client.websocket.send_json({
            "type": "client_list",
            "clients": other_clients
        })
        logger.info(f"Sent client list to {to_client_id}: {len(other_clients)} clients")

    async def broadcast_client_joined(self, new_client_id: str):
        """新規クライアント参加を他クライアントに通知"""
        new_client = self.ptt_manager.clients.get(new_client_id)
        if not new_client:
            return

        for client in self.ptt_manager.clients.values():
            if client.client_id != new_client_id:
                try:
                    await client.websocket.send_json({
                        "type": "client_joined",
                        "clientId": new_client_id,
                        "displayName": new_client.display_name
                    })
                except Exception:
                    pass

    async def broadcast_client_left(self, left_client_id: str):
        """クライアント切断を他クライアントに通知"""
        for client in self.ptt_manager.clients.values():
            if client.client_id != left_client_id:
                try:
                    await client.websocket.send_json({
                        "type": "client_left",
                        "clientId": left_client_id
                    })
                except Exception:
                    pass

    async def handle_websocket(self, request):
        """WebSocketシグナリング"""
        ws = web.WebSocketResponse(heartbeat=30.0)  # 30秒ごとにping/pong
        await ws.prepare(request)

        # クライアントID生成
        client_id = str(uuid.uuid4())[:8]
        client = ClientConnection(
            client_id=client_id,
            websocket=ws,
            display_name=f"Client-{client_id[:4]}"
        )
        self.ptt_manager.clients[client_id] = client

        logger.info(f"WebSocket connected from {request.remote} (id: {client_id})")

        # ICE設定とクライアントIDを送信
        await ws.send_json({
            "type": "config",
            "iceServers": self.ice_servers_for_client,
            "clientId": client_id
        })

        # 現在のPTT状態を送信
        await ws.send_json({
            "type": "ptt_status",
            "state": "transmitting" if self.ptt_manager.current_speaker else "idle",
            "speaker": self.ptt_manager.current_speaker,
            "speakerName": self.ptt_manager.get_speaker_name()
        })

        # RTCPeerConnectionを作成（ICEサーバー設定付き）
        config = RTCConfiguration(iceServers=self.ice_servers)
        pc = RTCPeerConnection(configuration=config)
        client.peer_connection = pc
        self.pcs.add(pc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info(f"Connection state: {pc.connectionState}")
            if pc.connectionState in ("failed", "closed"):
                await pc.close()
                self.pcs.discard(pc)

        @pc.on("icecandidate")
        async def on_icecandidate(candidate):
            if candidate:
                await ws.send_json({
                    "type": "ice-candidate",
                    "candidate": {
                        "candidate": candidate.candidate,
                        "sdpMid": candidate.sdpMid,
                        "sdpMLineIndex": candidate.sdpMLineIndex
                    }
                })

        @pc.on("track")
        def on_track(track):
            """クライアントからの音声トラックを受信"""
            if track.kind == "audio":
                client.remote_audio_track = track
                logger.info(f"Received audio track from {client_id}")

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    data = msg.json()
                    logger.info(f"Received: {data['type']}")

                    if data["type"] == "offer":
                        # Offer受信
                        offer_sdp = data["sdp"]
                        if "relay" in offer_sdp:
                            logger.info("Client offer contains relay candidates")
                        else:
                            logger.warning("Client offer does NOT contain relay candidates!")

                        offer = RTCSessionDescription(sdp=offer_sdp, type="offer")
                        await pc.setRemoteDescription(offer)

                        # このクライアント用のマイクトラックを作成（main方式: 各クライアントに独立トラック）
                        mic_track = MicrophoneAudioTrack(DEVICE_INDEX, SAMPLE_RATE)
                        self.mic_tracks.append(mic_track)
                        pc.addTrack(mic_track)

                        # Answer作成
                        answer = await pc.createAnswer()
                        await pc.setLocalDescription(answer)

                        # ICE gathering完了を待つ
                        while pc.iceGatheringState != "complete":
                            await asyncio.sleep(0.1)

                        # ICE候補を含むSDPを送信
                        sdp = pc.localDescription.sdp
                        await ws.send_json({
                            "type": "answer",
                            "sdp": sdp
                        })
                        logger.info(f"Answer sent with ICE candidates (gathering: {pc.iceGatheringState})")
                        # SDPにrelay候補が含まれているか確認
                        if "relay" in sdp:
                            logger.info("SDP contains relay candidates")
                        else:
                            logger.warning("SDP does NOT contain relay candidates!")

                        # P2P接続用: 既存クライアントに新規参加を通知
                        await self.broadcast_client_joined(client_id)
                        # P2P接続用: 新規クライアントに既存クライアントリストを送信
                        await self.send_client_list(client_id)

                    elif data["type"] == "ice-candidate" and data.get("candidate"):
                        # 受信したICE候補をPeerConnectionに追加
                        candidate_data = data["candidate"]
                        candidate_str = candidate_data.get("candidate", "")

                        if "relay" in candidate_str:
                            logger.info(f"Adding relay ICE candidate: {candidate_str[:80]}...")
                        else:
                            logger.debug(f"Adding ICE candidate: {candidate_str[:50]}...")

                        # aiortcでICE候補を追加
                        try:
                            # candidate文字列をパース
                            # 形式: "candidate:foundation component protocol priority ip port typ type ..."
                            parts = candidate_str.split()
                            if len(parts) >= 8 and parts[0].startswith("candidate:"):
                                foundation = parts[0].split(":")[1]
                                component = int(parts[1])
                                protocol = parts[2]
                                priority = int(parts[3])
                                ip = parts[4]
                                port = int(parts[5])
                                candidate_type = parts[7]  # "typ" の後

                                candidate = RTCIceCandidate(
                                    component=component,
                                    foundation=foundation,
                                    ip=ip,
                                    port=port,
                                    priority=priority,
                                    protocol=protocol,
                                    type=candidate_type,
                                    sdpMid=candidate_data.get("sdpMid"),
                                    sdpMLineIndex=candidate_data.get("sdpMLineIndex")
                                )
                                await pc.addIceCandidate(candidate)
                                logger.info(f"ICE candidate added successfully: {candidate_type}")
                        except Exception as e:
                            logger.warning(f"Failed to add ICE candidate: {e}")

                    elif data["type"] == "ptt_request":
                        # PTT送信権要求
                        if self.ptt_manager.request_floor(client_id):
                            await ws.send_json({"type": "ptt_granted"})
                            await self.broadcast_ptt_status()
                        else:
                            await ws.send_json({
                                "type": "ptt_denied",
                                "speaker": self.ptt_manager.current_speaker,
                                "speakerName": self.ptt_manager.get_speaker_name()
                            })

                    elif data["type"] == "ptt_release":
                        # PTT送信権解放
                        if self.ptt_manager.release_floor(client_id):
                            await self.broadcast_ptt_status()

                    # ========== P2Pシグナリング中継 ==========
                    elif data["type"] == "p2p_offer":
                        # P2P Offerを対象クライアントに中継
                        target = self.ptt_manager.clients.get(data.get("to"))
                        if target:
                            await target.websocket.send_json({
                                "type": "p2p_offer",
                                "from": client_id,
                                "sdp": data["sdp"]
                            })
                            logger.info(f"P2P offer relayed: {client_id} -> {data.get('to')}")

                    elif data["type"] == "p2p_answer":
                        # P2P Answerを対象クライアントに中継
                        target = self.ptt_manager.clients.get(data.get("to"))
                        if target:
                            await target.websocket.send_json({
                                "type": "p2p_answer",
                                "from": client_id,
                                "sdp": data["sdp"]
                            })
                            logger.info(f"P2P answer relayed: {client_id} -> {data.get('to')}")

                    elif data["type"] == "p2p_ice_candidate":
                        # P2P ICE候補を対象クライアントに中継
                        target = self.ptt_manager.clients.get(data.get("to"))
                        if target:
                            await target.websocket.send_json({
                                "type": "p2p_ice_candidate",
                                "from": client_id,
                                "candidate": data.get("candidate")
                            })

                elif msg.type == WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {ws.exception()}")

        except Exception as e:
            logger.error(f"WebSocket handler error: {e}")

        finally:
            # 切断時に送信権を解放
            if self.ptt_manager.release_floor(client_id):
                await self.broadcast_ptt_status()

            # P2P接続用: 他クライアントに切断を通知
            await self.broadcast_client_left(client_id)

            # クライアント情報削除
            self.ptt_manager.clients.pop(client_id, None)

            await pc.close()
            self.pcs.discard(pc)
            logger.info(f"WebSocket disconnected (id: {client_id})")

        return ws

    async def on_shutdown(self, app):
        """シャットダウン時のクリーンアップ"""
        logger.info("Shutting down...")

        # 全PeerConnectionをクローズ
        coros = [pc.close() for pc in self.pcs]
        await asyncio.gather(*coros)
        self.pcs.clear()

        # マイクトラック停止
        for track in self.mic_tracks:
            track.stop()
        self.mic_tracks.clear()

    async def ptt_timeout_checker(self):
        """PTTタイムアウトを定期チェック"""
        while True:
            await asyncio.sleep(1.0)  # 1秒ごとにチェック
            timed_out = self.ptt_manager.check_timeout()
            if timed_out:
                await self.broadcast_ptt_status()

    async def run(self):
        """サーバー起動"""
        # asyncio例外ハンドラを設定
        asyncio.get_event_loop().set_exception_handler(exception_handler)

        # サーバー起動
        runner = web.AppRunner(self.app)
        await runner.setup()

        site = web.TCPSite(runner, HOST, PORT)
        await site.start()

        logger.info("=" * 50)
        logger.info("  WebRTC PTT Bidirectional Server")
        logger.info("=" * 50)
        logger.info(f"  Device: {DEVICE_INDEX}")
        logger.info(f"  Sample Rate: {SAMPLE_RATE}Hz")
        logger.info(f"  PTT Timeout: {PTT_TIMEOUT}s")
        logger.info(f"  URL: http://{HOST}:{PORT}/")
        logger.info("=" * 50)

        # PTTタイムアウトチェッカーを起動
        asyncio.create_task(self.ptt_timeout_checker())

        # 永続実行
        await asyncio.Event().wait()


def main():
    server = StreamServer()
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        logger.info("Interrupted by user")


if __name__ == "__main__":
    main()
