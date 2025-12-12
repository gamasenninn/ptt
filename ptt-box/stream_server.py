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
from dataclasses import dataclass, field
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
    if exception and 'TransactionFailed' in str(type(exception)):
        # TURN transaction失敗は無視（relay-to-relay禁止など）
        pass
    else:
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


# ========== PTT管理 ==========

@dataclass
class ClientConnection:
    """クライアント接続情報"""
    client_id: str
    websocket: web.WebSocketResponse
    peer_connection: Optional[RTCPeerConnection] = None
    remote_audio_track: Optional[MediaStreamTrack] = None
    display_name: str = "Anonymous"


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
    """マイク入力をWebRTC音声トラックとして提供（共有インスタンス対応）"""

    kind = "audio"
    _instance: Optional["MicrophoneAudioTrack"] = None
    _ref_count = 0

    @classmethod
    def get_shared_instance(cls, device_index: int, sample_rate: int = 48000) -> "MicrophoneAudioTrack":
        """共有インスタンスを取得（シングルトンパターン）"""
        if cls._instance is None:
            cls._instance = cls(device_index, sample_rate)
        cls._ref_count += 1
        return cls._instance

    @classmethod
    def release_shared_instance(cls):
        """共有インスタンスの参照を解放"""
        cls._ref_count -= 1
        if cls._ref_count <= 0 and cls._instance:
            cls._instance.stop()
            cls._instance = None
            cls._ref_count = 0

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


class AudioRelayTrack(MediaStreamTrack):
    """PTT送信者の音声を他クライアントにリレーするトラック"""

    kind = "audio"

    def __init__(
        self,
        ptt_manager: PTTManager,
        listener_id: str,
        mic_track: MicrophoneAudioTrack,
        sample_rate: int = 48000
    ):
        super().__init__()
        self._ptt_manager = ptt_manager
        self._listener_id = listener_id
        self._mic_track = mic_track
        self._sample_rate = sample_rate
        self._samples_per_frame = int(sample_rate * FRAME_DURATION)
        self._pts = 0

    def _create_silence_frame(self) -> av.AudioFrame:
        """無音フレームを生成"""
        silence = np.zeros((1, self._samples_per_frame), dtype=np.int16)
        frame = av.AudioFrame.from_ndarray(silence, format='s16', layout='mono')
        frame.sample_rate = self._sample_rate
        frame.pts = self._pts
        frame.time_base = Fraction(1, self._sample_rate)
        self._pts += self._samples_per_frame
        return frame

    async def recv(self) -> av.AudioFrame:
        """送信者の音声を取得してリレー"""
        speaker_id = self._ptt_manager.current_speaker

        # 送信者がいない、または自分が送信者の場合は無音
        if speaker_id is None or speaker_id == self._listener_id:
            await asyncio.sleep(FRAME_DURATION)
            return self._create_silence_frame()

        # PCマイクからの送信
        if speaker_id == "pc_mic":
            try:
                frame = await asyncio.wait_for(
                    self._mic_track.recv(),
                    timeout=FRAME_DURATION * 2
                )
                # ptsを自分用に更新
                frame.pts = self._pts
                self._pts += self._samples_per_frame
                return frame
            except asyncio.TimeoutError:
                return self._create_silence_frame()

        # 他のクライアントからの送信
        client = self._ptt_manager.clients.get(speaker_id)
        if client and client.remote_audio_track:
            try:
                frame = await asyncio.wait_for(
                    client.remote_audio_track.recv(),
                    timeout=FRAME_DURATION * 2
                )
                frame.pts = self._pts
                self._pts += self._samples_per_frame
                return frame
            except asyncio.TimeoutError:
                return self._create_silence_frame()

        # フォールバック: 無音
        await asyncio.sleep(FRAME_DURATION)
        return self._create_silence_frame()


class StreamServer:
    """HTTP + WebSocketサーバー"""

    def __init__(self):
        self.app = web.Application()
        self.pcs: set[RTCPeerConnection] = set()
        self.relay_tracks: list[AudioRelayTrack] = []  # 各接続用のリレートラック
        self.ptt_manager = PTTManager()  # PTT管理
        self.mic_track: Optional[MicrophoneAudioTrack] = None  # 共有マイクトラック

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
        self.app.router.add_static('/js', CLIENT_DIR / 'js')

        # シャットダウン時のクリーンアップ
        self.app.on_shutdown.append(self.on_shutdown)

    async def handle_index(self, request):
        """index.html配信"""
        return web.FileResponse(CLIENT_DIR / 'index.html')

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

                        # 共有マイクトラックを初期化（初回のみ）
                        if self.mic_track is None:
                            self.mic_track = MicrophoneAudioTrack(DEVICE_INDEX, SAMPLE_RATE)

                        # このクライアント用のリレートラックを作成
                        relay_track = AudioRelayTrack(
                            ptt_manager=self.ptt_manager,
                            listener_id=client_id,
                            mic_track=self.mic_track,
                            sample_rate=SAMPLE_RATE
                        )
                        self.relay_tracks.append(relay_track)
                        pc.addTrack(relay_track)

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

                elif msg.type == WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {ws.exception()}")

        except Exception as e:
            logger.error(f"WebSocket handler error: {e}")

        finally:
            # 切断時に送信権を解放
            if self.ptt_manager.release_floor(client_id):
                await self.broadcast_ptt_status()

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

        # リレートラック停止
        for track in self.relay_tracks:
            track.stop()
        self.relay_tracks.clear()

        # 共有マイクトラック停止
        if self.mic_track:
            self.mic_track.stop()
            self.mic_track = None

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
