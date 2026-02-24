# git filter-repo ガイド

Git履歴からファイルを完全に削除するための手順書。
誤ってコミットした認証情報や秘密ファイルの除去に使用する。

## 背景（実例）

`dbhub.toml`（MySQL接続情報：ユーザー名・パスワード・IPアドレスを含む）を誤ってコミット・プッシュしてしまった。`git rm` だけでは追跡を外すだけで、過去のコミット履歴にファイルが残り続ける。

## 前提条件

- `git-filter-repo` がインストール済み
- リポジトリで作業しているのが自分だけ（force pushの影響範囲がない）

```bash
# インストール確認
pip show git-filter-repo

# 未インストールの場合
pip install git-filter-repo
```

## 手順

### 1. まず通常の削除と .gitignore 追加

```bash
# Git追跡から外す（ローカルファイルは残る）
git rm --cached ptt-box/dbhub.toml

# .gitignore に追加して今後追跡されないようにする
echo "ptt-box/dbhub.toml" >> .gitignore

# コミット
git add .gitignore
git commit -m "fix: remove dbhub.toml from repo (contains credentials)"
git push
```

この時点で最新のツリーからは消えるが、**過去のコミット履歴にはファイルが残っている**。

### 2. 履歴に残っていることを確認

```bash
git log --all --oneline -- ptt-box/dbhub.toml
```

出力例:
```
d20b065 fix: remove dbhub.toml from repo (contains DB credentials)
0f49694 feat: add DBHub MCP for MySQL readonly access
```

### 3. git filter-repo で履歴から完全削除

```bash
git filter-repo --path ptt-box/dbhub.toml --invert-paths --force
```

| オプション | 意味 |
|-----------|------|
| `--path <ファイル>` | 対象ファイルを指定 |
| `--invert-paths` | 指定したファイルを**除外**する（これがないと逆に指定ファイルだけ残る） |
| `--force` | フレッシュクローンでなくても実行を許可 |

### 4. 削除されたことを確認

```bash
# 履歴に残っていないか（出力なし=成功）
git log --all --oneline -- ptt-box/dbhub.toml

# ローカルファイルは残っているか
ls -la ptt-box/dbhub.toml

# .gitignore で無視されているか
git check-ignore ptt-box/dbhub.toml
```

### 5. リモートに force push

```bash
# filter-repo がリモートを削除するので再追加が必要な場合がある
git remote add origin https://github.com/<user>/<repo>.git 2>/dev/null

# force push（履歴の書き換えなので必須）
git push origin main --force
```

## 注意事項

### force push について

- 通常の `push` は「追加」、force push は「上書き」
- リモートの履歴が完全に書き換わる
- **他にクローンしている人がいる場合、再クローンが必要になる**
- 自分しか使っていないリポジトリなら問題なし

### 復旧方法

万一の場合でも復旧手段がある:

```bash
# ローカルの操作履歴を確認（force push前の状態に戻せる）
git reflog
git reset --hard <reflog-hash>
```

### 複数ファイルの削除

```bash
# 複数ファイルを一度に削除
git filter-repo --path file1.toml --path file2.json --invert-paths --force

# パターンで削除（正規表現）
git filter-repo --path-regex '.*\.env\..*' --invert-paths --force
```

### 認証情報を漏洩した場合のベストプラクティス

1. まずパスワードを変更する（最優先）
2. `git filter-repo` で履歴から削除
3. `.gitignore` に追加して再発防止

履歴の削除だけでは不十分。GitHubのキャッシュやフォーク先に残る可能性があるため、**パスワード変更が最も重要**。
