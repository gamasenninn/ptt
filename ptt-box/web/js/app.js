// SRT Viewer Application

let currentFile = null;

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    loadFileList();
});

// Load file list
function loadFileList() {
    fetch('api.php?action=list')
        .then(function(response) {
            return response.json();
        })
        .then(function(data) {
            if (data.success) {
                renderFileList(data.files);
            } else {
                showError(data.error);
            }
        })
        .catch(function(error) {
            showError('ファイル一覧の取得に失敗しました: ' + error.message);
        });
}

// Render file list
function renderFileList(files) {
    var container = document.getElementById('file-list');

    if (files.length === 0) {
        container.innerHTML = '<p class="loading">ファイルがありません</p>';
        return;
    }

    var html = '';
    for (var i = 0; i < files.length; i++) {
        var file = files[i];
        html += '<div class="file-item">';
        html += '<span class="file-datetime">' + (file.datetime || '-') + '</span>';
        html += '<span class="file-name">' + escapeHtml(file.filename) + '</span>';
        html += '<span class="file-preview" id="preview-' + i + '">-</span>';
        html += '<div class="file-actions">';
        html += '<button class="btn btn-play" onclick="playAudio(\'' + escapeHtml(file.wavFile) + '\')">再生</button>';
        html += '<button class="btn btn-edit" onclick="openEditor(\'' + escapeHtml(file.filename) + '\')">編集</button>';
        html += '</div>';
        html += '</div>';
    }

    container.innerHTML = html;

    // Load previews asynchronously
    for (var j = 0; j < files.length; j++) {
        loadPreview(files[j].filename, j);
    }
}

// Load preview text
function loadPreview(filename, index) {
    fetch('api.php?action=get&file=' + encodeURIComponent(filename))
        .then(function(response) {
            return response.json();
        })
        .then(function(data) {
            if (data.success && data.file.segments.length > 0) {
                var previewText = data.file.segments.map(function(seg) {
                    return seg.text;
                }).join(' ').substring(0, 100);
                var element = document.getElementById('preview-' + index);
                if (element) {
                    element.textContent = previewText + (previewText.length >= 100 ? '...' : '');
                }
            }
        })
        .catch(function() {
            // Ignore preview errors
        });
}

// Play audio
function playAudio(wavFile) {
    var audio = document.getElementById('audio-player');
    audio.src = '../recordings/' + wavFile;
    audio.play();
}

// Open editor
function openEditor(filename) {
    fetch('api.php?action=get&file=' + encodeURIComponent(filename))
        .then(function(response) {
            return response.json();
        })
        .then(function(data) {
            if (data.success) {
                currentFile = data.file;
                document.getElementById('editor-title').textContent = filename;
                document.getElementById('srt-editor').value = data.file.content;
                document.getElementById('audio-player').src = '../recordings/' + data.file.wavFile;
                document.getElementById('editor-modal').style.display = 'flex';
            } else {
                showError(data.error);
            }
        })
        .catch(function(error) {
            showError('ファイルの取得に失敗しました: ' + error.message);
        });
}

// Close editor
function closeEditor() {
    document.getElementById('editor-modal').style.display = 'none';
    document.getElementById('audio-player').pause();
    currentFile = null;
}

// Save SRT
function saveSrt() {
    if (!currentFile) {
        return;
    }

    var content = document.getElementById('srt-editor').value;

    var formData = new FormData();
    formData.append('action', 'save');
    formData.append('file', currentFile.filename);
    formData.append('content', content);

    fetch('api.php', {
        method: 'POST',
        body: formData
    })
        .then(function(response) {
            return response.json();
        })
        .then(function(data) {
            if (data.success) {
                alert('保存しました');
                closeEditor();
                loadFileList();
            } else {
                showError(data.error);
            }
        })
        .catch(function(error) {
            showError('保存に失敗しました: ' + error.message);
        });
}

// Show error
function showError(message) {
    alert('エラー: ' + message);
}

// Escape HTML
function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Handle keyboard shortcuts
document.addEventListener('keydown', function(e) {
    // ESC to close modal
    if (e.key === 'Escape') {
        if (document.getElementById('editor-modal').style.display === 'flex') {
            closeEditor();
        }
    }

    // Ctrl+S to save
    if (e.ctrlKey && e.key === 's') {
        if (document.getElementById('editor-modal').style.display === 'flex') {
            e.preventDefault();
            saveSrt();
        }
    }
});
