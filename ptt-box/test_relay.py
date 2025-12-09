"""
USB RELAY X-RL2 テストプログラム

Usage:
    uv run python ptt-box/test_relay.py
"""

import serial
import time
import sys

COM_PORT = "COM3"
BAUD_RATE = 9600


def relay_a_on(ser):
    """リレーA ON"""
    ser.write(b'A1')
    print("リレーA ON")


def relay_a_off(ser):
    """リレーA OFF"""
    ser.write(b'A0')
    print("リレーA OFF")


def relay_b_on(ser):
    """リレーB ON"""
    ser.write(b'B1')
    print("リレーB ON")


def relay_b_off(ser):
    """リレーB OFF"""
    ser.write(b'B0')
    print("リレーB OFF")


def main():
    try:
        ser = serial.Serial(COM_PORT, BAUD_RATE, timeout=1)
        print(f"接続: {COM_PORT}")
        time.sleep(0.5)

        # テスト: リレーA ON/OFF を3回繰り返す
        print("\n=== リレーA テスト ===")
        for i in range(3):
            print(f"\n--- テスト {i + 1} ---")
            relay_a_on(ser)
            time.sleep(2)
            relay_a_off(ser)
            time.sleep(2)

        # テスト: リレーB ON/OFF を3回繰り返す
        print("\n=== リレーB テスト ===")
        for i in range(3):
            print(f"\n--- テスト {i + 1} ---")
            relay_b_on(ser)
            time.sleep(2)
            relay_b_off(ser)
            time.sleep(2)

        ser.close()
        print("\n完了")

    except serial.SerialException as e:
        print(f"エラー: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
