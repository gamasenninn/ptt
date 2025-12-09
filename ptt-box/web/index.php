<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#2c3e50">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>トランシーバー履歴</title>
    <link rel="stylesheet" href="css/style.css">
    <link rel="manifest" href="manifest.json">
    <link rel="icon" href="icon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="icon-192.png">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>トランシーバー履歴</h1>
            <div class="header-controls">
                <div class="volume-control">
                    <span class="volume-icon">🔈</span>
                    <input type="range" id="volumeSlider" min="0" max="100" value="100"
                           oninput="setVolume(this.value)">
                    <span id="volumeValue">100%</span>
                </div>
                <button class="btn-icon" onclick="loadFileList()" title="更新">🔄</button>
            </div>
        </div>

        <div id="file-list" class="file-list">
            <p>読み込み中...</p>
        </div>

        <div id="editor-modal" class="modal" style="display: none;">
            <div class="modal-content">
                <div class="modal-header">
                    <h2 id="editor-title">ファイル編集</h2>
                    <button class="close-btn" onclick="closeEditor()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="audio-player">
                        <audio id="audio-player" controls></audio>
                    </div>
                    <div class="editor-container">
                        <textarea id="srt-editor" rows="15"></textarea>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeEditor()">キャンセル</button>
                    <button class="btn btn-primary" onclick="saveSrt()">保存</button>
                </div>
            </div>
        </div>
    </div>

    <script src="js/app.js"></script>
</body>
</html>
