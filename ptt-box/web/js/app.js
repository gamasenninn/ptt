// SRT Viewer Application

let currentFile = null;
let currentPlayingFile = null;

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    loadFileList();

    // 再生終了時にplayingクラスを削除
    var audio = document.getElementById('audio-player');
    audio.addEventListener('ended', function() {
        clearPlayingState();
    });
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
        html += '<div class="file-item" data-filename="' + escapeHtml(file.filename) + '" onclick="playAudio(\'' + escapeHtml(file.wavFile) + '\')">';

        // 1段目: アイコン + 日付 + clientId + 編集ボタン
        html += '<div class="file-item-row1">';
        var sourceIcon = file.source === 'analog' ? '📻' : '📱';
        html += '<span class="source-badge ' + (file.source || 'unknown') + '" title="' + (file.source === 'analog' ? 'アナログ' : 'Web') + '">' + sourceIcon + '</span>';
        html += '<span class="file-datetime">' + (file.datetimeShort || '-') + '</span>';
        if (file.clientId) {
            html += '<span class="client-id">' + escapeHtml(file.clientId) + '</span>';
        }
        html += '<div class="file-actions">';
        html += '<button class="btn-icon" onclick="event.stopPropagation(); openEditor(\'' + escapeHtml(file.filename) + '\')" title="編集">✏️</button>';
        html += '</div>';
        html += '</div>';

        // 2段目: 内容プレビュー
        html += '<div class="file-item-row2">';
        html += '<span class="file-preview">' + escapeHtml(file.preview || '-') + '</span>';
        html += '</div>';

        html += '</div>';
    }

    container.innerHTML = html;
}

// Play audio (toggle)
function playAudio(wavFile) {
    var audio = document.getElementById('audio-player');

    // 同じファイルをクリックした場合はトグル
    if (currentPlayingFile === wavFile) {
        if (audio.paused) {
            audio.play();
            setPlayingState(wavFile);
        } else {
            audio.pause();
            clearPlayingState();
        }
        return;
    }

    // 別のファイルを再生
    clearPlayingState();
    audio.src = 'audio.php?file=' + encodeURIComponent(wavFile);
    audio.play();
    setPlayingState(wavFile);
}

// 再生中状態を設定
function setPlayingState(wavFile) {
    currentPlayingFile = wavFile;
    var items = document.querySelectorAll('.file-item');
    items.forEach(function(item) {
        var filename = item.getAttribute('data-filename');
        if (filename && filename.replace('.srt', '.wav') === wavFile) {
            item.classList.add('playing');
        }
    });
}

// 再生中状態をクリア
function clearPlayingState() {
    currentPlayingFile = null;
    var items = document.querySelectorAll('.file-item.playing');
    items.forEach(function(item) {
        item.classList.remove('playing');
    });
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
                document.getElementById('audio-player').src = 'audio.php?file=' + encodeURIComponent(data.file.wavFile);
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

// Set volume
function setVolume(value) {
    var audio = document.getElementById('audio-player');
    var volumeValue = document.getElementById('volumeValue');

    if (audio) {
        audio.volume = value / 100;
    }
    if (volumeValue) {
        volumeValue.textContent = value + '%';
    }
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
