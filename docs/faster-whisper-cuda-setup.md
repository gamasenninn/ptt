# faster-whisper + CUDA 環境構築の知見

## 問題

faster-whisper を CUDA (GPU) で動作させる際、以下のエラーが発生することがある：

1. **cuDNN バージョン不整合**
   ```
   Could not locate cudnn_ops64_9.dll
   ```
   - 原因: 新しい onnxruntime (1.20+) は cuDNN 9.x を要求するが、システムには cuDNN 8.x がインストールされている

2. **NumPy バージョン不整合**
   ```
   A module that was compiled using NumPy 1.x cannot be run in NumPy 2.x
   ```
   - 原因: onnxruntime 1.17.x は NumPy 1.x でビルドされている

3. **Python バージョン制約**
   ```
   onnxruntime (v1.20.1) only has wheels with Python implementation tags: cp310, cp311, cp312, cp313
   ```
   - 原因: 新しい onnxruntime は Python 3.10+ が必要

4. **faster-whisper バージョン不整合**
   ```
   ImportError: cannot import name 'xxx' from 'faster_whisper.utils'
   ```
   - 原因: faster-whisper の新しいバージョン (1.1.0+) は依存パッケージのバージョンが異なる
   - av, tokenizers などの依存パッケージも固定が必要

## 解決策

cuDNN 8.x 環境で動作させるには、以下のバージョンを固定する：

```toml
# pyproject.toml
dependencies = [
    "numpy==1.26.4",
    "faster-whisper==1.0.2",
    "onnxruntime==1.17.3",
    "ctranslate2==4.2.1",
    "av==12.0.0",
    "tokenizers==0.19.1",
]
```

### 動作確認済み環境

- Python: 3.10+
- CUDA: 11.x / 12.x
- cuDNN: 8.x
- GPU: NVIDIA GeForce シリーズ

### バージョン依存関係

| パッケージ | バージョン | 備考 |
|-----------|-----------|------|
| faster-whisper | 1.0.2 | 1.1.0以降は依存関係が変更 |
| onnxruntime | 1.17.3 | cuDNN 8.x 対応の最終版 |
| ctranslate2 | 4.2.1 | onnxruntime 1.17.x 互換 |
| numpy | 1.26.4 | NumPy 1.x 系の最終版 |
| av | 12.0.0 | faster-whisper 1.0.2 互換 |
| tokenizers | 0.19.1 | faster-whisper 1.0.2 互換 |

## 注意事項

- `pkg_resources is deprecated` の警告は無視して問題ない
- cuDNN 9.x にアップグレードすれば、より新しいバージョンの組み合わせが使用可能
- faster-whisper のバージョンを上げると依存パッケージも連動して変わるため、全体を固定することが重要
