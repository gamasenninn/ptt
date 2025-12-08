# Docker Compose 運用Tips

## ボリュームマウントの相対パス問題

### 問題

docker-compose.ymlで相対パスを使用している場合、**実行ディレクトリによってマウント先が変わる**。

```yaml
volumes:
  - ./recordings:/var/www/html/recordings
```

### 症状

- コンテナ内のファイルが古いまま
- 新しいファイルが見えない
- ホスト側にはファイルがあるのにコンテナ内にない

### 原因

`./recordings`は実行時のカレントディレクトリからの相対パス：

| 実行ディレクトリ | マウントされるパス |
|----------------|-------------------|
| `C:\app\ptt\ptt-box` | `C:\app\ptt\ptt-box\recordings` ✓ |
| `C:\app\ptt` | `C:\app\ptt\recordings` ✗ |
| `C:\Users\user` | `C:\Users\user\recordings` ✗ |

### 解決策

1. **常にdocker-compose.ymlがあるディレクトリから実行する**
   ```bash
   cd C:\app\ptt\ptt-box
   docker-compose up -d
   ```

2. **問題が発生したらコンテナを再起動**
   ```bash
   cd C:\app\ptt\ptt-box
   docker-compose down
   docker-compose up -d
   ```

3. **絶対パスを使用する（オプション）**
   ```yaml
   volumes:
     - C:/app/ptt/ptt-box/recordings:/var/www/html/recordings
   ```

### 確認方法

コンテナ内のファイルを確認：
```bash
docker exec -it ptt-box-web-1 ls -la /var/www/html/recordings/
```
