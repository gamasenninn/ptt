// History Tab - SRT履歴機能

let historyFiles = [];
let currentPlayingFile = null;
let editingFilename = null;

// タブ切り替え
function switchTab(tabName) {
    // タブボタンのアクティブ状態を更新
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');

    // タブコンテンツの表示を切り替え
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById('tab-' + tabName).classList.add('active');

    // 履歴タブに切り替えたら読み込み
    if (tabName === 'history') {
        loadHistory();
    }
}

// 履歴一覧読み込み
async function loadHistory() {
    const listEl = document.getElementById('historyList');
    listEl.innerHTML = '<div class="history-loading">読み込み中...</div>';

    try {
        const res = await fetch('/api/srt/list');
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || 'Failed to load');
        }

        historyFiles = data.files;
        renderHistoryList();
    } catch (e) {
        listEl.innerHTML = '<div class="history-empty">読み込みに失敗しました</div>';
        console.error('Load history error:', e);
    }
}

// 履歴一覧描画
function renderHistoryList() {
    const listEl = document.getElementById('historyList');

    if (historyFiles.length === 0) {
        listEl.innerHTML = '<div class="history-empty">履歴がありません</div>';
        return;
    }

    let html = '';
    for (const file of historyFiles) {
        const isPlaying = currentPlayingFile === file.wavFile;
        const playingClass = isPlaying ? 'playing' : '';
        const playIcon = isPlaying ? '⏹' : '▶';
        const sourceIcon = file.source === 'analog' ? '📻' : '📱';

        html += `
            <div class="history-item ${playingClass}" data-wav="${file.wavFile}" data-filename="${file.filename}" onclick="playHistoryAudio('${file.wavFile}')">
                <div class="history-row1">
                    <span class="history-play-icon">${playIcon}</span>
                    <span class="source-badge" title="${file.source === 'analog' ? 'アナログ' : 'Web'}">${sourceIcon}</span>
                    <span class="history-datetime">${file.datetimeShort || file.datetime || '-'}</span>
                    ${file.clientId ? `<span class="client-id">${escapeHtml(file.clientId)}</span>` : ''}
                    <button class="history-edit-btn" onclick="event.stopPropagation(); openEditor('${file.filename}', '${file.wavFile}')">編集</button>
                </div>
                <div class="history-row2">
                    <span class="history-preview">${escapeHtml(file.preview) || '(内容なし)'}</span>
                </div>
            </div>
        `;
    }
    listEl.innerHTML = html;
}

// HTMLエスケープ
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 音声再生（トグル）
function playHistoryAudio(wavFile) {
    const audio = document.getElementById('historyAudio');

    // トランシーバーの音量設定を反映
    const volumeSlider = document.getElementById('volumeSlider');
    if (volumeSlider) {
        audio.volume = volumeSlider.value / 100;
    }

    // 同じファイルなら停止
    if (currentPlayingFile === wavFile) {
        audio.pause();
        audio.currentTime = 0;
        currentPlayingFile = null;
        renderHistoryList();
        return;
    }

    // 新しいファイルを再生
    audio.src = '/api/audio?file=' + encodeURIComponent(wavFile);
    audio.play().catch(e => console.error('Play error:', e));
    currentPlayingFile = wavFile;
    renderHistoryList();
}

// 音声終了時
document.addEventListener('DOMContentLoaded', () => {
    const audio = document.getElementById('historyAudio');
    if (audio) {
        audio.addEventListener('ended', () => {
            currentPlayingFile = null;
            renderHistoryList();
        });
    }
});

// SRT編集モーダルを開く
async function openEditor(filename, wavFile) {
    const modal = document.getElementById('editModal');
    const textarea = document.getElementById('editTextarea');
    const audioPlayer = document.getElementById('editAudioPlayer');

    try {
        const res = await fetch('/api/srt/get?file=' + encodeURIComponent(filename));
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || 'Failed to load');
        }

        editingFilename = filename;
        textarea.value = data.file.content;

        // 音声プレイヤーを設定
        if (audioPlayer && wavFile) {
            audioPlayer.src = '/api/audio?file=' + encodeURIComponent(wavFile);
            // トランシーバーの音量設定を反映
            const volumeSlider = document.getElementById('volumeSlider');
            if (volumeSlider) {
                audioPlayer.volume = volumeSlider.value / 100;
            }
        }

        modal.classList.add('active');
    } catch (e) {
        alert('読み込みに失敗しました: ' + e.message);
    }
}

// SRT編集モーダルを閉じる
function closeEditor() {
    const modal = document.getElementById('editModal');
    const audioPlayer = document.getElementById('editAudioPlayer');

    // 音声を停止
    if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
    }

    modal.classList.remove('active');
    editingFilename = null;
}

// SRT保存
async function saveSrt() {
    if (!editingFilename) return;

    const textarea = document.getElementById('editTextarea');
    const content = textarea.value;

    try {
        const res = await fetch('/api/srt/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                file: editingFilename,
                content: content
            })
        });
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || 'Failed to save');
        }

        closeEditor();
        loadHistory();  // 一覧を更新
    } catch (e) {
        alert('保存に失敗しました: ' + e.message);
    }
}

// キーボードショートカット
document.addEventListener('keydown', (e) => {
    // ESC: モーダルを閉じる
    if (e.key === 'Escape') {
        closeEditor();
    }
    // Ctrl+S: 保存
    if (e.ctrlKey && e.key === 's') {
        const modal = document.getElementById('editModal');
        if (modal.classList.contains('active')) {
            e.preventDefault();
            saveSrt();
        }
    }
});
