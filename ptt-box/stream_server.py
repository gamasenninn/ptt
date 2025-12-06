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
        self.audio_tracks: list[MicrophoneAudioTrack] = []  # 各接続用のトラック

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

    async def handle_websocket(self, request):
        """WebSocketシグナリング"""
        ws = web.WebSocketResponse(heartbeat=30.0)  # 30秒ごとにping/pong
        await ws.prepare(request)

        logger.info(f"WebSocket connected from {request.remote}")

        # ICE設定をクライアントに送信
        await ws.send_json({
            "type": "config",
            "iceServers": self.ice_servers_for_client
        })

        # RTCPeerConnectionを作成（ICEサーバー設定付き）
        config = RTCConfiguration(iceServers=self.ice_servers)
        pc = RTCPeerConnection(configuration=config)
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
                        offer_sdp = data["sdp"]
                        if "relay" in offer_sdp:
                            logger.info("Client offer contains relay candidates")
                        else:
                            logger.warning("Client offer does NOT contain relay candidates!")

                        offer = RTCSessionDescription(sdp=offer_sdp, type="offer")
                        await pc.setRemoteDescription(offer)

                        # この接続用の音声トラックを作成
                        audio_track = MicrophoneAudioTrack(DEVICE_INDEX, SAMPLE_RATE)
                        self.audio_tracks.append(audio_track)
                        pc.addTrack(audio_track)

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

        # 全音声トラック停止
        for track in self.audio_tracks:
            track.stop()
        self.audio_tracks.clear()

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
