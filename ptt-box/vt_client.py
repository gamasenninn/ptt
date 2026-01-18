"""
Virtual Transceiver Client (vt_client.py)
Webトランシーバーに接続するバーチャルトランシーバー

機能:
- WebSocket + WebRTC接続（サーバーとの接続）
- P2P接続（他クライアントとの直接接続）
- P2Pで受信した音声をスピーカー出力
- PTT状態の受信と表示

Usage:
    uv run python ptt-box/vt_client.py
"""

import os
import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Optional

import numpy as np
import sounddevice as sd
from dotenv import load_dotenv

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer, MediaStreamTrack
import av


def force_opus_mono(sdp: str) -> str:
    """SDPのOpus設定をモノラル強制に変更（ブラウザのforceOpusMonoと同等）"""
    opus_match = re.search(r'a=rtpmap:(\d+) opus/48000/2', sdp)
    if not opus_match:
        return sdp
    payload_type = opus_match.group(1)

    fmtp_regex = re.compile(f'a=fmtp:{payload_type} (.+)')
    if fmtp_regex.search(sdp):
        # 既存のfmtpにstereo設定を追加
        sdp = fmtp_regex.sub(f'a=fmtp:{payload_type} \\1;stereo=0;sprop-stereo=0', sdp)
    else:
        # fmtpがない場合、rtpmapの後に追加
        sdp = re.sub(
            f'(a=rtpmap:{payload_type} opus/48000/2)',
            f'\\1\r\na=fmtp:{payload_type} stereo=0;sprop-stereo=0',
            sdp
        )
    return sdp

# ログ設定
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# aiortc/aioiceのログレベルを下げる
logging.getLogger('aioice').setLevel(logging.WARNING)
logging.getLogger('aiortc').setLevel(logging.WARNING)

# 環境変数読み込み
load_dotenv()

# 接続先
VT_SERVER_URL = os.environ.get("VT_SERVER_URL", "ws://localhost:9320/ws")

# 音声デバイス
VT_MIC_DEVICE_INDEX = int(os.environ.get("VT_MIC_DEVICE_INDEX", "1"))
VT_SPEAKER_DEVICE_INDEX = int(os.environ.get("VT_SPEAKER_DEVICE_INDEX", "5"))

# 定数
SAMPLE_RATE = 48000
CHANNELS = 1
FRAME_DURATION = 0.020  # 20ms
SAMPLES_PER_FRAME = int(SAMPLE_RATE * FRAME_DURATION)


class MicrophoneTrack(MediaStreamTrack):
    """PCマイク入力をWebRTCトラックとして提供"""

    kind = "audio"

    def __init__(self, device_index: int, sample_rate: int = 48000):
        super().__init__()
        self._sample_rate = sample_rate
        self._samples_per_frame = int(sample_rate * FRAME_DURATION)
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self._pts = 0
        self._loop = asyncio.get_event_loop()
        self._enabled = False  # ミュート状態で開始

        logger.info(f"Opening microphone device {device_index} at {sample_rate}Hz")

        self._stream = sd.InputStream(
            device=device_index,
            samplerate=sample_rate,
            blocksize=self._samples_per_frame,
            channels=CHANNELS,
            dtype=np.int16,
            callback=self._audio_callback
        )
        self._stream.start()
        logger.info("Microphone stream started")

    def _audio_callback(self, indata, frames, time_info, status):
        """音声コールバック（別スレッドで実行）"""
        if status:
            logger.warning(f"Audio callback status: {status}")

        if not self._enabled:
            # ミュート中は無音を送る
            data = np.zeros_like(indata)
        else:
            data = indata.copy()

        try:
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

        frame = av.AudioFrame.from_ndarray(
            data.T,
            format='s16',
            layout='mono'
        )
        frame.sample_rate = self._sample_rate
        frame.pts = self._pts
        frame.time_base = Fraction(1, self._sample_rate)

        self._pts += self._samples_per_frame

        return frame

    def set_enabled(self, enabled: bool):
        """トラックの有効/無効を切り替え"""
        self._enabled = enabled
        logger.info(f"Microphone track {'enabled' if enabled else 'disabled'}")

    def stop(self):
        """ストリーム停止"""
        super().stop()
        if self._stream:
            self._stream.stop()
            self._stream.close()
            logger.info("Microphone stream stopped")


class SpeakerOutput:
    """WebRTC受信音声をPCスピーカーに出力"""

    def __init__(self, device_index: int, sample_rate: int = 48000, channels: int = 1):
        self._device_index = device_index
        self._sample_rate = sample_rate
        self._channels = channels
        self._stream: Optional[sd.OutputStream] = None
        self._running = False

    def start(self):
        """出力開始"""
        if self._stream:
            return

        logger.info(f"Opening speaker device {self._device_index} at {self._sample_rate}Hz, {self._channels}ch")
        self._stream = sd.OutputStream(
            device=self._device_index,
            samplerate=self._sample_rate,
            channels=self._channels,
            dtype=np.float32
        )
        self._stream.start()
        self._running = True
        logger.info("Speaker output started")

    def write(self, audio_data: np.ndarray, is_stereo: bool = False):
        """音声データを出力"""
        if not self._stream or not self._running:
            return

        # ステレオデータをモノラルスピーカーに出力する場合
        if is_stereo and self._channels == 1:
            # インターリーブステレオ(L,R,L,R,...)をモノラルに変換
            left = audio_data[0::2]
            right = audio_data[1::2]
            audio_data = (left + right) / 2

        # shape調整: (samples,) → (samples, channels)
        if audio_data.ndim == 1:
            audio_data = audio_data.reshape(-1, 1)

        self._stream.write(audio_data)

    def stop(self):
        """出力停止"""
        self._running = False
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
            logger.info("Speaker output stopped")


@dataclass
class P2PConnection:
    """P2P接続情報"""
    client_id: str
    pc: RTCPeerConnection
    remote_audio_track: Optional[MediaStreamTrack] = None
    receive_task: Optional[asyncio.Task] = None
    pending_candidates: list = field(default_factory=list)
    remote_description_set: bool = False


class VirtualTransceiver:
    """バーチャルトランシーバー本体"""

    def __init__(self, server_url: str):
        self.server_url = server_url
        self.ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self.pc: Optional[RTCPeerConnection] = None
        self.client_id: Optional[str] = None
        self.ice_servers = []
        self.ice_server_objs = []  # RTCIceServerオブジェクト

        # 音声
        self.mic_track: Optional[MicrophoneTrack] = None
        self.speaker_output: Optional[SpeakerOutput] = None
        self.remote_audio_track: Optional[MediaStreamTrack] = None

        # P2P接続管理
        self.p2p_connections: dict[str, P2PConnection] = {}

        # PTT状態
        self.ptt_state = "idle"  # idle, transmitting, receiving
        self.current_speaker: Optional[str] = None
        self.current_speaker_name: Optional[str] = None

        # 接続状態
        self.connected = False
        self._receive_task: Optional[asyncio.Task] = None

    async def connect(self):
        """WebSocket + WebRTC接続"""
        logger.info(f"Connecting to {self.server_url}")

        # WebSocket接続
        session = aiohttp.ClientSession()
        try:
            self.ws = await session.ws_connect(self.server_url, heartbeat=30.0)
            logger.info("WebSocket connected")
        except Exception as e:
            logger.error(f"WebSocket connection failed: {e}")
            await session.close()
            raise

        # configメッセージを待つ
        await self._wait_for_config()

        # スピーカー出力を開始
        self.speaker_output = SpeakerOutput(VT_SPEAKER_DEVICE_INDEX, SAMPLE_RATE)
        self.speaker_output.start()

        # WebRTC接続を確立
        await self._setup_webrtc()

        self.connected = True
        logger.info("Virtual Transceiver connected")

    async def _wait_for_config(self):
        """configメッセージを待つ"""
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data.get("type") == "config":
                    self.client_id = data.get("clientId")
                    self.ice_servers = data.get("iceServers", [])
                    logger.info(f"Received config: clientId={self.client_id}")
                    logger.info(f"ICE servers: {[s.get('urls') for s in self.ice_servers]}")
                    break
                elif data.get("type") == "ptt_status":
                    # 初期PTT状態
                    self._handle_ptt_status(data)

    def _build_ice_server_objs(self):
        """ICEサーバーオブジェクトを構築"""
        self.ice_server_objs = []
        for server in self.ice_servers:
            urls = server.get("urls", [])
            username = server.get("username")
            credential = server.get("credential")

            if username and credential:
                self.ice_server_objs.append(RTCIceServer(
                    urls=urls,
                    username=username,
                    credential=credential
                ))
            else:
                self.ice_server_objs.append(RTCIceServer(urls=urls))

    async def _setup_webrtc(self):
        """WebRTC接続を確立"""
        # ICEサーバー設定
        self._build_ice_server_objs()

        config = RTCConfiguration(iceServers=self.ice_server_objs)
        self.pc = RTCPeerConnection(configuration=config)

        # 接続状態変更ハンドラ
        @self.pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info(f"Connection state: {self.pc.connectionState}")
            if self.pc.connectionState in ("failed", "closed"):
                self.connected = False

        # 音声トラック受信ハンドラ
        @self.pc.on("track")
        def on_track(track):
            logger.info(f"Received track: kind={track.kind}, id={track.id}")
            if track.kind == "audio":
                self.remote_audio_track = track
                # 音声受信タスクを開始
                self._receive_task = asyncio.create_task(self._receive_audio_loop())

        # マイクトラックを追加（ミュート状態で開始）
        self.mic_track = MicrophoneTrack(VT_MIC_DEVICE_INDEX, SAMPLE_RATE)
        self.pc.addTrack(self.mic_track)

        # Offer作成（Opusモノラル設定を適用）
        offer = await self.pc.createOffer()
        mono_sdp = force_opus_mono(offer.sdp)
        await self.pc.setLocalDescription(RTCSessionDescription(sdp=mono_sdp, type="offer"))

        # ICE gathering完了を待つ
        logger.info("Waiting for ICE gathering...")
        await self._wait_for_ice_gathering()

        # Offer送信
        await self.ws.send_json({
            "type": "offer",
            "sdp": self.pc.localDescription.sdp
        })
        logger.info("Offer sent")

        # Answer受信を待つ
        await self._wait_for_answer()

    async def _wait_for_ice_gathering(self):
        """ICE gathering完了を待つ"""
        if self.pc.iceGatheringState == "complete":
            return

        gathering_complete = asyncio.Event()

        @self.pc.on("icegatheringstatechange")
        def on_icegatheringstatechange():
            logger.info(f"ICE gathering state: {self.pc.iceGatheringState}")
            if self.pc.iceGatheringState == "complete":
                gathering_complete.set()

        # 最大10秒待つ
        try:
            await asyncio.wait_for(gathering_complete.wait(), timeout=10.0)
        except asyncio.TimeoutError:
            logger.warning("ICE gathering timeout, proceeding anyway")

    async def _wait_for_answer(self):
        """Answerを待つ"""
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)

                if data.get("type") == "answer":
                    answer = RTCSessionDescription(sdp=data["sdp"], type="answer")
                    await self.pc.setRemoteDescription(answer)
                    logger.info("Answer received and set")
                    break
                elif data.get("type") == "ice-candidate":
                    # ICE候補を追加（簡易実装）
                    pass
                elif data.get("type") == "ptt_status":
                    self._handle_ptt_status(data)

    async def _receive_audio_loop(self):
        """音声受信ループ"""
        logger.info("Audio receive loop started")
        frame_count = 0

        try:
            while self.connected and self.remote_audio_track:
                try:
                    frame = await self.remote_audio_track.recv()

                    # フレームをnumpy配列に変換
                    audio_data = frame.to_ndarray()

                    # RMSを計算（デバッグ用）
                    rms = np.sqrt(np.mean(audio_data.astype(np.float32)**2))

                    if frame_count < 5:
                        logger.info(f"Audio frame {frame_count}: samples={audio_data.shape}, RMS={rms:.1f}")
                    frame_count += 1

                    # shape: (channels, samples) → (samples,)
                    if audio_data.ndim == 2:
                        audio_data = audio_data.flatten()

                    # float32に正規化
                    audio_float = audio_data.astype(np.float32) / 32768.0

                    # スピーカーに出力
                    if self.speaker_output:
                        self.speaker_output.write(audio_float)

                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error(f"Audio receive error: {e}")
                    await asyncio.sleep(0.1)

        finally:
            logger.info("Audio receive loop ended")

    def _handle_ptt_status(self, data: dict):
        """PTT状態を処理"""
        state = data.get("state", "idle")
        speaker = data.get("speaker")
        speaker_name = data.get("speakerName")

        old_state = self.ptt_state

        if speaker == self.client_id:
            self.ptt_state = "transmitting"
        elif state == "transmitting":
            self.ptt_state = "receiving"
        else:
            self.ptt_state = "idle"

        self.current_speaker = speaker
        self.current_speaker_name = speaker_name

        if old_state != self.ptt_state:
            logger.info(f"PTT state: {self.ptt_state} (speaker: {speaker_name or 'none'})")

    # ========== P2P接続管理 ==========

    async def _create_p2p_connection(self, remote_client_id: str, is_offerer: bool) -> P2PConnection:
        """P2P接続を作成"""
        logger.info(f"Creating P2P connection to {remote_client_id} (offerer={is_offerer})")

        config = RTCConfiguration(iceServers=self.ice_server_objs)
        pc = RTCPeerConnection(configuration=config)

        conn = P2PConnection(client_id=remote_client_id, pc=pc)
        self.p2p_connections[remote_client_id] = conn

        # 接続状態変更ハンドラ
        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info(f"P2P {remote_client_id}: connection state = {pc.connectionState}")
            if pc.connectionState in ("failed", "closed"):
                await self._close_p2p_connection(remote_client_id)

        # 音声トラック受信ハンドラ
        @pc.on("track")
        def on_track(track):
            logger.info(f"P2P {remote_client_id}: received track kind={track.kind}")
            if track.kind == "audio":
                conn.remote_audio_track = track
                # 音声受信タスクを開始
                conn.receive_task = asyncio.create_task(
                    self._p2p_receive_audio_loop(remote_client_id, track)
                )

        # ICE候補送信ハンドラ
        @pc.on("icecandidate")
        async def on_icecandidate(candidate):
            if candidate:
                await self.ws.send_json({
                    "type": "p2p_ice_candidate",
                    "to": remote_client_id,
                    "candidate": {
                        "candidate": candidate.candidate,
                        "sdpMid": candidate.sdpMid,
                        "sdpMLineIndex": candidate.sdpMLineIndex
                    }
                })

        # マイクトラックを追加（ミュート状態）
        # 注: 各P2P接続で同じmic_trackを共有
        if self.mic_track:
            pc.addTrack(self.mic_track)

        return conn

    async def _p2p_receive_audio_loop(self, remote_client_id: str, track: MediaStreamTrack):
        """P2P音声受信ループ"""
        logger.info(f"P2P {remote_client_id}: audio receive loop started")
        frame_count = 0

        try:
            while self.connected:
                try:
                    frame = await track.recv()

                    # フレームをnumpy配列に変換
                    audio_data = frame.to_ndarray()

                    # RMSを計算（デバッグ用）
                    rms = np.sqrt(np.mean(audio_data.astype(np.float32)**2))

                    # 最初の5フレームは詳細ログ
                    if frame_count < 5:
                        logger.info(f"P2P {remote_client_id}: frame {frame_count}")
                        logger.info(f"  format={frame.format.name}, layout={frame.layout.name}, rate={frame.sample_rate}")
                        logger.info(f"  samples={frame.samples}, shape={audio_data.shape}, dtype={audio_data.dtype}")
                        logger.info(f"  RMS={rms:.1f}, min={audio_data.min()}, max={audio_data.max()}")
                    elif frame_count % 50 == 0:
                        logger.info(f"P2P {remote_client_id}: frame {frame_count}, RMS={rms:.1f}, ptt={self.ptt_state}")
                    frame_count += 1

                    # shape: (1, samples*2) → (samples*2,)
                    if audio_data.ndim == 2:
                        audio_data = audio_data.flatten()

                    # float32に正規化
                    audio_float = audio_data.astype(np.float32) / 32768.0

                    # ステレオかどうか判定
                    is_stereo = (len(audio_data) == frame.samples * 2)

                    # 音声があればスピーカーに出力（RMS閾値でフィルタリング）
                    if self.speaker_output and rms > 10:
                        self.speaker_output.write(audio_float, is_stereo=is_stereo)

                except asyncio.CancelledError:
                    break
                except Exception as e:
                    if "MediaStreamError" not in str(type(e)):
                        logger.error(f"P2P {remote_client_id}: audio error: {e}")
                    break

        finally:
            logger.info(f"P2P {remote_client_id}: audio receive loop ended")

    async def _handle_client_list(self, clients: list):
        """クライアントリストを処理（既存クライアントにP2P接続）"""
        # 既存クライアントには自分からOfferを送る（ブラウザと同じ動作）
        logger.info(f"Client list: {len(clients)} clients")
        for client in clients:
            remote_id = client.get("clientId")
            if remote_id and remote_id not in self.p2p_connections:
                await self._initiate_p2p_offer(remote_id)

    async def _handle_client_joined(self, data: dict):
        """新規クライアント参加を処理"""
        remote_id = data.get("clientId")
        display_name = data.get("displayName", remote_id)
        logger.info(f"Client joined: {display_name}")
        # 新規参加者からはOfferが来るのを待つ
        # （ブラウザのclient_joinedハンドラと同じ: 相手がclient_listで自分を見てOfferを送る）

    async def _handle_client_left(self, data: dict):
        """クライアント離脱を処理"""
        remote_id = data.get("clientId")
        logger.info(f"Client left: {remote_id}")
        await self._close_p2p_connection(remote_id)

    async def _initiate_p2p_offer(self, remote_client_id: str):
        """P2P Offerを送信"""
        conn = await self._create_p2p_connection(remote_client_id, is_offerer=True)

        # Offer作成
        offer = await conn.pc.createOffer()
        # SDPにOpusモノラル設定を適用
        mono_sdp = force_opus_mono(offer.sdp)
        await conn.pc.setLocalDescription(RTCSessionDescription(sdp=mono_sdp, type="offer"))

        # ICE gathering完了を待つ（簡易版: 最大5秒）
        for _ in range(50):
            if conn.pc.iceGatheringState == "complete":
                break
            await asyncio.sleep(0.1)

        # Offer送信
        await self.ws.send_json({
            "type": "p2p_offer",
            "to": remote_client_id,
            "sdp": conn.pc.localDescription.sdp
        })
        logger.info(f"P2P offer sent to {remote_client_id}")

    async def _handle_p2p_offer(self, data: dict):
        """P2P Offerを受信"""
        from_id = data.get("from")
        sdp = data.get("sdp")

        if not from_id or not sdp:
            return

        logger.info(f"P2P offer received from {from_id}")

        # 接続を作成（または既存を取得）
        conn = self.p2p_connections.get(from_id)
        if not conn:
            conn = await self._create_p2p_connection(from_id, is_offerer=False)

        # Remote descriptionを設定
        await conn.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
        conn.remote_description_set = True

        # 保留中のICE候補を処理
        for candidate in conn.pending_candidates:
            try:
                await conn.pc.addIceCandidate(candidate)
            except Exception as e:
                logger.warning(f"Failed to add pending ICE candidate: {e}")
        conn.pending_candidates.clear()

        # Answer作成
        answer = await conn.pc.createAnswer()
        # SDPにOpusモノラル設定を適用
        mono_sdp = force_opus_mono(answer.sdp)
        await conn.pc.setLocalDescription(RTCSessionDescription(sdp=mono_sdp, type="answer"))

        # ICE gathering完了を待つ
        for _ in range(50):
            if conn.pc.iceGatheringState == "complete":
                break
            await asyncio.sleep(0.1)

        # Answer送信
        await self.ws.send_json({
            "type": "p2p_answer",
            "to": from_id,
            "sdp": conn.pc.localDescription.sdp
        })
        logger.info(f"P2P answer sent to {from_id}")

    async def _handle_p2p_answer(self, data: dict):
        """P2P Answerを受信"""
        from_id = data.get("from")
        sdp = data.get("sdp")

        if not from_id or not sdp:
            return

        conn = self.p2p_connections.get(from_id)
        if not conn:
            logger.warning(f"P2P answer from unknown client: {from_id}")
            return

        logger.info(f"P2P answer received from {from_id}")

        await conn.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="answer"))
        conn.remote_description_set = True

        # 保留中のICE候補を処理
        for candidate in conn.pending_candidates:
            try:
                await conn.pc.addIceCandidate(candidate)
            except Exception as e:
                logger.warning(f"Failed to add pending ICE candidate: {e}")
        conn.pending_candidates.clear()

    async def _handle_p2p_ice_candidate(self, data: dict):
        """P2P ICE候補を受信"""
        from_id = data.get("from")
        candidate_data = data.get("candidate")

        if not from_id or not candidate_data:
            return

        conn = self.p2p_connections.get(from_id)
        if not conn:
            # まだ接続がない場合は作成
            conn = await self._create_p2p_connection(from_id, is_offerer=False)

        # ICE候補を構築
        from aiortc import RTCIceCandidate
        candidate_str = candidate_data.get("candidate", "")

        if not candidate_str:
            return

        try:
            parts = candidate_str.split()
            if len(parts) >= 8 and parts[0].startswith("candidate:"):
                candidate = RTCIceCandidate(
                    component=int(parts[1]),
                    foundation=parts[0].split(":")[1],
                    ip=parts[4],
                    port=int(parts[5]),
                    priority=int(parts[3]),
                    protocol=parts[2],
                    type=parts[7],
                    sdpMid=candidate_data.get("sdpMid"),
                    sdpMLineIndex=candidate_data.get("sdpMLineIndex")
                )

                if conn.remote_description_set:
                    await conn.pc.addIceCandidate(candidate)
                else:
                    conn.pending_candidates.append(candidate)

        except Exception as e:
            logger.warning(f"Failed to parse ICE candidate: {e}")

    async def _close_p2p_connection(self, remote_client_id: str):
        """P2P接続を閉じる"""
        conn = self.p2p_connections.pop(remote_client_id, None)
        if conn:
            if conn.receive_task:
                conn.receive_task.cancel()
                try:
                    await conn.receive_task
                except asyncio.CancelledError:
                    pass
            await conn.pc.close()
            logger.info(f"P2P connection closed: {remote_client_id}")

    async def run(self):
        """メインループ"""
        logger.info("Virtual Transceiver running...")

        try:
            # WebSocketメッセージを受信
            async for msg in self.ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    msg_type = data.get("type")

                    if msg_type == "ptt_status":
                        self._handle_ptt_status(data)
                    elif msg_type == "ice-candidate":
                        # サーバーとのICE候補（簡易実装）
                        pass
                    elif msg_type == "client_list":
                        await self._handle_client_list(data.get("clients", []))
                    elif msg_type == "client_joined":
                        await self._handle_client_joined(data)
                    elif msg_type == "client_left":
                        await self._handle_client_left(data)
                    # P2Pシグナリング
                    elif msg_type == "p2p_offer":
                        await self._handle_p2p_offer(data)
                    elif msg_type == "p2p_answer":
                        await self._handle_p2p_answer(data)
                    elif msg_type == "p2p_ice_candidate":
                        await self._handle_p2p_ice_candidate(data)

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {self.ws.exception()}")
                    break

        except asyncio.CancelledError:
            pass
        finally:
            await self.disconnect()

    async def disconnect(self):
        """切断"""
        logger.info("Disconnecting...")

        self.connected = False

        # P2P接続をクローズ
        for remote_id in list(self.p2p_connections.keys()):
            await self._close_p2p_connection(remote_id)

        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass

        if self.mic_track:
            self.mic_track.stop()

        if self.speaker_output:
            self.speaker_output.stop()

        if self.pc:
            await self.pc.close()

        if self.ws:
            await self.ws.close()

        logger.info("Disconnected")


async def main():
    """メイン関数"""
    logger.info("=" * 50)
    logger.info("  Virtual Transceiver")
    logger.info("=" * 50)
    logger.info(f"  Server: {VT_SERVER_URL}")
    logger.info(f"  Mic Device: {VT_MIC_DEVICE_INDEX}")
    logger.info(f"  Speaker Device: {VT_SPEAKER_DEVICE_INDEX}")
    logger.info("=" * 50)

    vt = VirtualTransceiver(VT_SERVER_URL)

    try:
        await vt.connect()
        await vt.run()
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    except Exception as e:
        logger.error(f"Error: {e}")
    finally:
        await vt.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
