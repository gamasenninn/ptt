# stream_server 自動テスト

## 概要

stream_server (Node.js) の自動テスト環境。Jest フレームワークを使用。

## 実行コマンド

```bash
cd ptt-box/stream_server

# 全テスト実行
npm test

# カバレッジレポート付き
npm run test:coverage

# ウォッチモード（ファイル変更時に自動実行）
npm run test:watch
```

## テスト構成

```
stream_server/
├── __tests__/
│   ├── utils.test.js        # Phase 1: 純粋関数
│   ├── ptt-manager.test.js  # Phase 2: 状態管理
│   └── api.test.js          # Phase 3: APIエンドポイント
├── jest.config.js           # Jest設定
└── package.json             # テストスクリプト
```

### Phase 1: 純粋関数テスト (`utils.test.js`)

副作用のないユーティリティ関数のテスト。

| 関数 | テスト内容 |
|------|----------|
| `formatUptime()` | 稼働時間フォーマット（秒→日時分秒） |
| `extractDatetimeFromFilename()` | ファイル名から日時抽出 |
| `extractDatetimeForSort()` | ソート用日時文字列抽出 |
| `extractSourceInfo()` | ソース種別とclientId抽出 |
| `getSrtPreview()` | SRTファイルのプレビュー生成 |

### Phase 2: PTTManager テスト (`ptt-manager.test.js`)

PTT（Push-To-Talk）状態管理クラスのテスト。

| メソッド | テスト内容 |
|---------|----------|
| `requestFloor()` | 送信権取得（idle→許可、busy→拒否） |
| `releaseFloor()` | 送信権解放（正しいclient→成功） |
| `checkTimeout()` | タイムアウト判定 |
| `getState()` | 状態取得（idle/transmitting） |

テストケース例：
- idle状態でrequestFloor → true
- busy状態でrequestFloor → false
- タイムアウト超過で自動解放
- PTT_TIMEOUT=0 でタイムアウト無効化

### Phase 3: API テスト (`api.test.js`)

Express HTTPエンドポイントのテスト。supertest使用。

| エンドポイント | テスト内容 |
|---------------|----------|
| `POST /api/vox/on` | VOX PTT取得（成功/失敗） |
| `POST /api/vox/off` | VOX PTT解放 |
| `GET /api/dash/status` | サーバーステータス取得 |
| `GET /api/dash/ptt` | PTT状態取得 |
| `POST /api/dash/ptt/release` | PTT強制解放 |

## テストのメリット

### 1. リグレッション防止
コード変更時に既存機能が壊れていないか即座に検出。

```
コード変更 → npm test → 問題検出
```

### 2. 安心してリファクタリング
server.js（1800行超）の構造改善が安全に行える。

### 3. 仕様のドキュメント化
テストコードが動作仕様を明確化：

```javascript
test('busy状態では他のクライアントは拒否される', () => {
  manager.requestFloor('client1');
  expect(manager.requestFloor('client2')).toBe(false);
});
```

### 4. デバッグ効率化
問題発生 → 再現テスト作成 → 修正 → テスト通過

## テスト追加ガイド

### 新しい純粋関数のテスト追加

1. `server.js` で関数をエクスポート
2. `__tests__/utils.test.js` にテストケース追加

```javascript
// server.js 末尾
module.exports = {
  // ... 既存
  newFunction,  // 追加
};

// utils.test.js
describe('newFunction', () => {
  test('期待する動作', () => {
    expect(newFunction(input)).toBe(expected);
  });
});
```

### 新しいAPIのテスト追加

`__tests__/api.test.js` の `createTestApp()` にルート追加：

```javascript
app.post('/api/new/endpoint', (req, res) => {
  // ハンドラ実装
});

// テストケース
describe('POST /api/new/endpoint', () => {
  test('正常系', async () => {
    const res = await request(app)
      .post('/api/new/endpoint')
      .expect(200);
    expect(res.body.success).toBe(true);
  });
});
```

## 依存関係

```json
{
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^7.0.0"
  }
}
```
