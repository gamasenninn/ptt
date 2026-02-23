// History Tab - SRT履歴機能

let historyFiles = [];
let currentPlayingFile = null;
let editingFilename = null;
let autoPlayIndex = -1;  // 連続再生中の現在位置（historyFilesのindex）、-1 = 無効

// Pull-to-Refresh 状態
let pullStartY = 0;
let isPulling = false;
let isRefreshing = false;

// タブ切り替え
function switchTab(tabName) {
    // タブボタンのアクティブ状態を更新
    document.querySelectorAll('.tab-btn').forEach((btn, index) => {
        btn.classList.remove('active');
        // タブ名に対応するボタンをアクティブに
        const tabNames = ['transceiver', 'history', 'ai', 'admin'];
        if (tabNames[index] === tabName) {
            btn.classList.add('active');
        }
    });

    // タブコンテンツの表示を切り替え
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById('tab-' + tabName).classList.add('active');

    // 履歴タブに切り替えたら読み込み
    if (tabName === 'history') {
        loadHistory();
    } else if (tabName === 'admin') {
        // 管理タブ: 初回のみ iframe を読み込み
        const iframe = document.getElementById('admin-iframe');
        if (!iframe.src || iframe.src === '' || iframe.src === window.location.href) {
            iframe.src = '/dash/';
        }
    }
}

// URLパラメータからタブを初期化
function initTabFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const standalone = params.get('standalone') === '1';

    if (tab && ['transceiver', 'history', 'ai', 'admin'].includes(tab)) {
        switchTab(tab);

        if (standalone) {
            // standaloneモード: タブナビを非表示
            const tabNav = document.querySelector('.tab-nav');
            if (tabNav) tabNav.style.display = 'none';
        } else {
            // 通常モード: URLをクリーンに（パラメータを削除）
            history.replaceState(null, '', window.location.pathname);
        }
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
                    ${file.clientId ? `<span class="client-id">${file.displayName ? escapeHtml(file.displayName) + ' (' + escapeHtml(file.clientId) + ')' : escapeHtml(file.clientId)}</span>` : ''}
                    <button class="history-edit-btn" onclick="event.stopPropagation(); openEditor('${file.filename}', '${file.wavFile}')">編集</button>
                </div>
                <div class="history-row2">
                    <span class="history-preview">${escapeHtml(file.preview) || '(内容なし)'}</span>
                </div>
            </div>
        `;
    }
    listEl.innerHTML = html;

    // 連続再生中: 再生中アイテムが見えるよう自動スクロール
    if (currentPlayingFile) {
        const playingEl = listEl.querySelector('.history-item.playing');
        if (playingEl) {
            playingEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

// HTMLエスケープ
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 履歴音量設定
function setHistoryVolume(value) {
    const audio = document.getElementById('historyAudio');
    const editAudio = document.getElementById('editAudioPlayer');
    const volumeValue = document.getElementById('historyVolumeValue');

    if (audio) audio.volume = value / 100;
    if (editAudio) editAudio.volume = value / 100;
    if (volumeValue) volumeValue.textContent = value + '%';

    // localStorageに保存
    localStorage.setItem('historyVolumeSlider', value);
}

// 保存された履歴音量を読み込み
function loadHistoryVolumeSetting() {
    const saved = localStorage.getItem('historyVolumeSlider');
    const slider = document.getElementById('historyVolumeSlider');
    const audio = document.getElementById('historyAudio');
    const volumeValue = document.getElementById('historyVolumeValue');

    if (saved !== null) {
        const vol = parseInt(saved, 10);
        if (slider) slider.value = vol;
        if (audio) audio.volume = vol / 100;
        if (volumeValue) volumeValue.textContent = vol + '%';
    } else if (audio) {
        audio.volume = 0.4;  // デフォルト40%
    }
}

// 音声再生（トグル）- クリック地点から時系列順（古い→新しい）に連続再生
function playHistoryAudio(wavFile) {
    const audio = document.getElementById('historyAudio');

    // 履歴用の音量設定を反映
    const volumeSlider = document.getElementById('historyVolumeSlider');
    if (volumeSlider) {
        audio.volume = volumeSlider.value / 100;
    }

    // 同じファイルなら停止（連続再生もキャンセル）
    if (currentPlayingFile === wavFile) {
        audio.pause();
        audio.currentTime = 0;
        currentPlayingFile = null;
        autoPlayIndex = -1;
        renderHistoryList();
        return;
    }

    // クリックされたファイルのindexを記録
    const idx = historyFiles.findIndex(f => f.wavFile === wavFile);
    autoPlayIndex = idx;

    // 新しいファイルを再生
    audio.src = '/api/audio?file=' + encodeURIComponent(wavFile);
    audio.play().catch(e => console.error('Play error:', e));
    currentPlayingFile = wavFile;
    renderHistoryList();
}

// 音声終了時 & 初期化
document.addEventListener('DOMContentLoaded', () => {
    const audio = document.getElementById('historyAudio');
    if (audio) {
        audio.addEventListener('ended', () => {
            // 連続再生: 時系列で次（index を1減らす = より新しいファイル）を再生
            if (autoPlayIndex > 0) {
                autoPlayIndex--;
                const nextFile = historyFiles[autoPlayIndex];
                if (nextFile && nextFile.wavFile) {
                    audio.src = '/api/audio?file=' + encodeURIComponent(nextFile.wavFile);
                    audio.play().catch(e => console.error('Auto play error:', e));
                    currentPlayingFile = nextFile.wavFile;
                    renderHistoryList();
                    return;
                }
            }
            // 最新まで再生完了 or 連続再生無効
            currentPlayingFile = null;
            autoPlayIndex = -1;
            renderHistoryList();
        });
    }

    // 保存された履歴音量を読み込み
    loadHistoryVolumeSetting();

    // Pull-to-Refresh 初期化
    initPullToRefresh();

    // URLパラメータからタブを初期化
    initTabFromUrl();
});

// Pull-to-Refresh 初期化
function initPullToRefresh() {
    const container = document.getElementById('historyListContainer');
    const indicator = document.getElementById('pullIndicator');
    const pullText = indicator?.querySelector('.pull-text');

    if (!container || !indicator) return;

    const PULL_THRESHOLD = 60;  // リフレッシュ発動の閾値（px）

    container.addEventListener('touchstart', (e) => {
        // スクロールが一番上のときだけ有効
        if (container.scrollTop === 0 && !isRefreshing) {
            pullStartY = e.touches[0].clientY;
            isPulling = true;
        }
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (!isPulling || isRefreshing) return;

        const currentY = e.touches[0].clientY;
        const pullDistance = currentY - pullStartY;

        if (pullDistance > 0 && container.scrollTop === 0) {
            // 引っ張り量に応じてインジケーターを表示
            if (pullDistance > 10) {
                indicator.classList.add('visible');
                indicator.classList.remove('refreshing');

                if (pullDistance >= PULL_THRESHOLD) {
                    if (pullText) pullText.textContent = '離すと更新';
                } else {
                    if (pullText) pullText.textContent = '↓ 引っ張って更新';
                }
            }
        }
    }, { passive: true });

    container.addEventListener('touchend', async () => {
        if (!isPulling || isRefreshing) return;

        const indicator = document.getElementById('pullIndicator');
        const pullText = indicator?.querySelector('.pull-text');

        if (indicator.classList.contains('visible')) {
            // リフレッシュ実行
            isRefreshing = true;
            indicator.classList.add('refreshing');
            if (pullText) pullText.textContent = '更新中...';

            await loadHistory();

            // 完了後にインジケーターを非表示
            setTimeout(() => {
                indicator.classList.remove('visible', 'refreshing');
                isRefreshing = false;
            }, 300);
        }

        isPulling = false;
        pullStartY = 0;
    });
}

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
            // 履歴用の音量設定を反映
            const volumeSlider = document.getElementById('historyVolumeSlider');
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
