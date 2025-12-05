"""
WebRTC Audio Streaming Server
PCマイク音声をリアルタイムでブラウザに配信

Usage:
    uv run python ptt-box/stream_server.py
"""

import os
import asyncio
import logging
from pathlib import Path
from fractions import Fraction

import numpy as np
import sounddevice as sd
from dotenv import load_dotenv

from aiohttp import web, WSMsgType
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
import av

# ログ設定
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 環境変数読み込み
load_dotenv()

DEVICE_INDEX = int(os.environ.get("STREAM_DEVICE_INDEX", "1"))
HOST = os.environ.get("STREAM_HOST", "0.0.0.0")
PORT = int(os.environ.get("STREAM_PORT", "8080"))
SAMPLE_RATE = int(os.environ.get("STREAM_SAMPLE_RATE", "48000"))

# 定数
CHANNELS = 1
FRAME_DURATION = 0.020  # 20ms
SAMPLES_PER_FRAME = int(SAMPLE_RATE * FRAME_DURATION)

# クライアントHTMLのパス
CLIENT_DIR = Path(__file__).parent / "stream_client"


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
        self.audio_track: MicrophoneAudioTrack | None = None

        # ルーティング設定
        self.app.router.add_get('/', self.handle_index)
        self.app.router.add_get('/ws', self.handle_websocket)
        self.app.router.add_static('/js', CLIENT_DIR / 'js')

        # シャットダウン時のクリーンアップ
        self.app.on_shutdown.append(self.on_shutdown)

    async def handle_index(self, request):
        """index.html配信"""
        return web.FileResponse(CLIENT_DIR / 'index.html')

    async def handle_websocket(self, request):
        """WebSocketシグナリング"""
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        logger.info(f"WebSocket connected from {request.remote}")

        pc = RTCPeerConnection()
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

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    data = msg.json()
                    logger.info(f"Received: {data['type']}")

                    if data["type"] == "offer":
                        # Offer受信
                        offer = RTCSessionDescription(sdp=data["sdp"], type="offer")
                        await pc.setRemoteDescription(offer)

                        # 音声トラックを追加
                        pc.addTrack(self.audio_track)

                        # Answer作成
                        answer = await pc.createAnswer()
                        await pc.setLocalDescription(answer)

                        await ws.send_json({
                            "type": "answer",
                            "sdp": pc.localDescription.sdp
                        })

                    elif data["type"] == "ice-candidate" and data.get("candidate"):
                        # aiortcはTrickle ICEを完全にはサポートしていないため
                        # ICE candidateはSDPに含まれる形で処理される
                        logger.debug(f"ICE candidate received (handled via SDP gathering)")

                elif msg.type == WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {ws.exception()}")

        except Exception as e:
            logger.error(f"WebSocket handler error: {e}")

        finally:
            await pc.close()
            self.pcs.discard(pc)
            logger.info("WebSocket disconnected")

        return ws

    async def on_shutdown(self, app):
        """シャットダウン時のクリーンアップ"""
        logger.info("Shutting down...")

        # 全PeerConnectionをクローズ
        coros = [pc.close() for pc in self.pcs]
        await asyncio.gather(*coros)
        self.pcs.clear()

        # 音声トラック停止
        if self.audio_track:
            self.audio_track.stop()

    async def run(self):
        """サーバー起動"""
        # 音声トラック初期化
        self.audio_track = MicrophoneAudioTrack(DEVICE_INDEX, SAMPLE_RATE)

        # サーバー起動
        runner = web.AppRunner(self.app)
        await runner.setup()

        site = web.TCPSite(runner, HOST, PORT)
        await site.start()

        logger.info("=" * 50)
        logger.info("  WebRTC Audio Streaming Server")
        logger.info("=" * 50)
        logger.info(f"  Device: {DEVICE_INDEX}")
        logger.info(f"  Sample Rate: {SAMPLE_RATE}Hz")
        logger.info(f"  URL: http://{HOST}:{PORT}/")
        logger.info("=" * 50)

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
