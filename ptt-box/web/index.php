<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SRT Viewer</title>
    <link rel="stylesheet" href="css/style.css">
</head>
<body>
    <div class="container">
        <h1>SRT Viewer</h1>

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
