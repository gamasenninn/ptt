"""
Vosk Realtime Speech Recognition WebSocket Server

WebSocket経由で音声ストリームを受信し、Voskで認識して
partial/final resultをJSON形式で返却する。

Usage:
    uv run python ptt-box/vosk_realtime.py

Protocol:
    Client → Server: Raw PCM audio (16-bit LE, 16kHz mono) as binary frames
    Client → Server: JSON text frames for control:
        {"eof": 1}  - End of stream, get final result
        {"config": {"sample_rate": 16000}}  - Configure sample rate

    Server → Client: JSON text frames:
        {"partial": "途中テキスト"}  - Partial (interim) result
        {"text": "確定テキスト"}    - Final result
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# Load environment variables
env_path = Path(__file__).parent / '.env'
load_dotenv(env_path)

VOSK_PORT = int(os.getenv('VOSK_PORT', '9322'))
VOSK_HOST = os.getenv('VOSK_HOST', '0.0.0.0')
VOSK_MODEL_PATH = os.getenv('VOSK_MODEL_PATH', '')
VOSK_SAMPLE_RATE = int(os.getenv('VOSK_SAMPLE_RATE', '16000'))

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [Vosk] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger(__name__)


def find_model_path():
    """Voskモデルパスを検出する。環境変数 > 自動検索の順。"""
    if VOSK_MODEL_PATH and os.path.isdir(VOSK_MODEL_PATH):
        return VOSK_MODEL_PATH

    # 自動検索: ptt-box/ 以下の vosk-model* ディレクトリ
    base_dir = Path(__file__).parent
    candidates = sorted(base_dir.glob('vosk-model*'), reverse=True)
    for candidate in candidates:
        if candidate.is_dir():
            return str(candidate)

    return None


async def handle_client(websocket):
    """1クライアントの音声認識セッションを処理する。"""
    from vosk import KaldiRecognizer

    sample_rate = VOSK_SAMPLE_RATE
    rec = KaldiRecognizer(model, sample_rate)
    rec.SetWords(False)
    # Partial results有効化
    rec.SetPartialWords(False)

    log.info(f'Client connected: {websocket.remote_address}')

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                # Raw PCM audio data
                if rec.AcceptWaveform(message):
                    # Final result
                    result = rec.Result()
                    await websocket.send(result)
                else:
                    # Partial result
                    partial = rec.PartialResult()
                    await websocket.send(partial)

            elif isinstance(message, str):
                # JSON control message
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue

                if data.get('eof'):
                    # End of stream - send final result
                    final = rec.FinalResult()
                    await websocket.send(final)
                    # Reset recognizer for next utterance
                    rec = KaldiRecognizer(model, sample_rate)
                    rec.SetWords(False)
                    rec.SetPartialWords(False)

                elif 'config' in data:
                    # Reconfigure sample rate
                    new_rate = data['config'].get('sample_rate', sample_rate)
                    if new_rate != sample_rate:
                        sample_rate = new_rate
                        rec = KaldiRecognizer(model, sample_rate)
                        rec.SetWords(False)
                        rec.SetPartialWords(False)
                        log.info(f'Sample rate changed to {sample_rate}')

    except Exception as e:
        log.info(f'Client disconnected: {websocket.remote_address} ({e})')
    else:
        log.info(f'Client disconnected: {websocket.remote_address}')


async def main():
    global model

    import websockets
    from vosk import Model, SetLogLevel

    # Vosk内部ログを抑制
    SetLogLevel(-1)

    model_path = find_model_path()
    if not model_path:
        log.error('Vosk model not found!')
        log.error('Download a model from https://alphacephei.com/vosk/models')
        log.error(f'Place it in: {Path(__file__).parent}/')
        log.error('Or set VOSK_MODEL_PATH in .env')
        sys.exit(1)

    log.info(f'Loading model: {model_path}')
    model = Model(model_path)
    log.info('Model loaded successfully')

    log.info(f'Starting WebSocket server on ws://{VOSK_HOST}:{VOSK_PORT}')

    async with websockets.serve(
        handle_client,
        VOSK_HOST,
        VOSK_PORT,
        max_size=None,  # No message size limit for audio
        ping_interval=30,
        ping_timeout=10,
    ):
        await asyncio.Future()  # Run forever


if __name__ == '__main__':
    asyncio.run(main())
