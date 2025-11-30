import sounddevice as sd

print("=== オーディオデバイス一覧 ===\n")
print(sd.query_devices())