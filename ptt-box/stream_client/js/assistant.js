// AI Assistant integration for Webトランシーバー
// Uses existing WebSocket connection from stream.js

// AI Voice input state
let aiRecognition = null;
let aiIsListening = false;
let aiRecognitionReady = false;
let aiVoiceFinalText = '';
let aiVoiceInterimText = '';
let aiSavedCursorPos = 0;
let aiLastAddedTranscript = '';  // Android重複防止用

// marked.js initialization
if (typeof marked !== 'undefined') {
    marked.setOptions({
        breaks: true,
        gfm: true
    });
}

// ========== AI Query Functions ==========

function sendAIQuery() {
    const textarea = document.getElementById('aiQueryInput');
    const query = textarea.value.trim();
    if (!query) return;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        addAIChatMessage('error', 'サーバーに接続されていません');
        return;
    }

    // Add user message to chat
    addAIChatMessage('user', query, false);

    // Show loading indicator
    const loadingMessage = addAIChatMessage('ai loading', '');
    loadingMessage.id = 'aiLoadingMessage';
    loadingMessage.querySelector('.content').innerHTML = '考え中<span class="ai-thinking-dots"><span>.</span><span>.</span><span>.</span></span>';

    // Get TTS mode from settings
    const ttsMode = typeof getTtsMode === 'function' ? getTtsMode() : 'server';

    // Send query through WebSocket (same as test_assistant.html)
    ws.send(JSON.stringify({
        type: 'ai_query',
        query: query,
        check_wake_word: false,
        tts_mode: ttsMode
    }));

    debugLog('AI query sent: ' + query.substring(0, 50) + '... (tts_mode=' + ttsMode + ')');

    // Clear input
    textarea.value = '';
}

function stopAITTS() {
    // クライアント側TTS（speechSynthesis）を停止
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }

    // サーバーからのWebRTC音声を停止
    if (typeof stopServerAudio === 'function') {
        stopServerAudio();
    }

    // サーバー側TTS停止リクエスト
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ai_stop_tts' }));
    }
    debugLog('AI stop TTS requested');
}

function clearAIChat() {
    const container = document.getElementById('aiChatContainer');
    container.innerHTML = '<div class="ai-chat-empty">AIに質問してみましょう...</div>';
}

// ========== AI Response Handling ==========

function handleAIResponse(data) {
    // Remove loading message
    const loading = document.getElementById('aiLoadingMessage');
    if (loading) loading.remove();

    if (data.error) {
        addAIChatMessage('ai error', 'エラー: ' + data.error, false);
        debugLog('AI error: ' + data.error);
    } else if (data.skipped) {
        const reason = data.reason || 'ウェイクワードなし';
        addAIChatMessage('ai skipped', 'スキップ: ' + reason, false);
        debugLog('AI skipped: ' + reason);
    } else if (data.response) {
        // AI response with Markdown rendering
        addAIChatMessage('ai', data.response, true);
        debugLog('AI response received');

        // Client-side TTS if mode is 'client'
        const ttsMode = typeof getTtsMode === 'function' ? getTtsMode() : 'server';
        if (ttsMode === 'client') {
            speakWithClientTTS(data.response);
        }
    }
}

// Client-side TTS using Web Speech API
function speakWithClientTTS(text) {
    if (!('speechSynthesis' in window)) {
        debugLog('Speech synthesis not supported');
        return;
    }

    // Cancel any ongoing speech
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
        debugLog('Client TTS started');
    };
    utterance.onend = () => {
        debugLog('Client TTS ended');
    };
    utterance.onerror = (e) => {
        debugLog('Client TTS error: ' + e.error);
    };

    speechSynthesis.speak(utterance);
}

function handleAITTSStopped(data) {
    if (data.stopped) {
        debugLog('AI TTS stopped');
    }
}

// ========== Chat Message Functions ==========

function addAIChatMessage(type, content, isMarkdown = false) {
    const container = document.getElementById('aiChatContainer');

    // Remove empty state
    const empty = container.querySelector('.ai-chat-empty');
    if (empty) empty.remove();

    const message = document.createElement('div');
    message.className = 'ai-chat-message ' + type;

    const roleText = type === 'user' ? 'あなた' : 'AI';
    let contentHtml;
    if (isMarkdown && typeof marked !== 'undefined') {
        contentHtml = marked.parse(content);
    } else {
        contentHtml = escapeHtmlAI(content);
    }

    message.innerHTML = '<div class="role">' + roleText + '</div><div class="content">' + contentHtml + '</div>';

    container.appendChild(message);
    container.scrollTop = container.scrollHeight;
    return message;
}

function escapeHtmlAI(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== Voice Input Functions ==========

// SpeechRecognition の初期化（getUserMediaは不要）
function setupAISpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition || aiRecognition) {
        return aiRecognition !== null;
    }

    const statusEl = document.getElementById('aiMicStatus');

    try {
        aiRecognition = new SpeechRecognition();
        aiRecognition.lang = 'ja-JP';
        // iOS Safari では continuous: true が問題を起こすことがある
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        aiRecognition.continuous = !isIOS;
        aiRecognition.interimResults = true;

        aiRecognition.onresult = (event) => {
            let sessionInterim = '';

            // event.resultIndex から始めて新しい結果のみ処理
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                const isFinal = event.results[i].isFinal;
                if (isFinal) {
                    // Android対策: 同じtranscriptの重複追加を防止
                    if (transcript && transcript !== aiLastAddedTranscript) {
                        aiVoiceFinalText += transcript;
                        aiLastAddedTranscript = transcript;
                    }
                } else {
                    sessionInterim += transcript;
                }
            }

            const previewContent = document.getElementById('aiVoicePreviewContent');
            const displayText = aiVoiceFinalText + sessionInterim;

            if (displayText) {
                previewContent.textContent = displayText;
                previewContent.classList.toggle('interim', sessionInterim.length > 0);
            } else {
                previewContent.textContent = '聞き取り中...';
                previewContent.classList.add('interim');
            }

            aiVoiceInterimText = sessionInterim;
        };

        aiRecognition.onerror = (event) => {
            debugLog('AI voice error: ' + event.error);
            if (statusEl) {
                if (event.error === 'not-allowed') {
                    statusEl.textContent = 'マイク許可なし';
                    statusEl.style.color = '#ff4757';
                } else if (event.error !== 'aborted') {
                    statusEl.textContent = 'エラー: ' + event.error;
                    statusEl.style.color = '#ff4757';
                }
            }
            stopAISpeechRecognition();
        };

        aiRecognition.onend = () => {
            if (aiIsListening) {
                // 継続モードでない場合は再起動を試みる
                try {
                    aiRecognition.start();
                } catch (e) {
                    debugLog('AI voice restart failed: ' + e.message);
                }
            }
        };

        aiRecognitionReady = true;
        debugLog('AI SpeechRecognition initialized');
        return true;

    } catch (err) {
        debugLog('AI SpeechRecognition setup error: ' + err.message);
        if (statusEl) {
            statusEl.textContent = '初期化エラー';
            statusEl.style.color = '#ff4757';
        }
        return false;
    }
}


function startAISpeechRecognition() {
    // 既に聞き取り中なら何もしない（二重起動防止）
    if (aiIsListening) {
        debugLog('AI speech recognition already listening');
        return;
    }

    // 初回は SpeechRecognition をセットアップ
    if (!aiRecognitionReady) {
        if (!setupAISpeechRecognition()) {
            debugLog('AI speech recognition setup failed');
            return;
        }
    }

    if (!aiRecognition) {
        debugLog('AI speech recognition not available');
        return;
    }

    const voiceBtn = document.getElementById('aiVoiceInputBtn');
    const preview = document.getElementById('aiVoicePreview');
    const previewContent = document.getElementById('aiVoicePreviewContent');
    const textarea = document.getElementById('aiQueryInput');
    const statusEl = document.getElementById('aiMicStatus');

    // Save cursor position
    aiSavedCursorPos = textarea.selectionStart;

    // Reset state
    aiVoiceFinalText = '';
    aiVoiceInterimText = '';
    aiLastAddedTranscript = '';
    aiIsListening = true;

    // Show preview
    previewContent.textContent = '聞き取り中...';
    previewContent.classList.add('interim');
    preview.classList.add('active');

    // WebRTCマイクを一時停止（SpeechRecognitionがマイクを使えるように）
    if (typeof pauseWebRTCMicrophone === 'function') {
        pauseWebRTCMicrophone();
    }

    try {
        aiRecognition.start();
        voiceBtn.textContent = '🎤 聞き取り中...';
        voiceBtn.classList.add('listening');
        if (statusEl) {
            statusEl.textContent = '音声認識中...';
            statusEl.style.color = '#2ed573';
        }
        debugLog('AI voice input started');
    } catch (e) {
        debugLog('AI voice start error: ' + e.message);
        aiIsListening = false;
        preview.classList.remove('active');
        // エラー時はマイクを再取得
        if (typeof resumeWebRTCMicrophone === 'function') {
            resumeWebRTCMicrophone();
        }
        if (statusEl) {
            statusEl.textContent = '開始エラー: ' + e.message;
            statusEl.style.color = '#ff4757';
        }
    }
}

function stopAISpeechRecognition() {
    aiIsListening = false;
    if (aiRecognition) {
        try {
            aiRecognition.stop();
        } catch (e) {}
    }

    const textarea = document.getElementById('aiQueryInput');
    const voiceBtn = document.getElementById('aiVoiceInputBtn');
    const preview = document.getElementById('aiVoicePreview');
    const previewContent = document.getElementById('aiVoicePreviewContent');
    const statusEl = document.getElementById('aiMicStatus');

    // Reset button state
    voiceBtn.textContent = '🎤 音声入力';
    voiceBtn.classList.remove('listening');

    // Get final text from preview
    const finalText = previewContent.textContent.trim();

    // Hide preview
    preview.classList.remove('active');

    // Insert text at cursor position
    if (finalText && finalText !== '聞き取り中...') {
        const text = textarea.value;
        const pos = aiSavedCursorPos;

        const before = text.substring(0, pos);
        const after = text.substring(pos);

        const needSpaceBefore = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n');
        const needSpaceAfter = after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n');

        const insertText = (needSpaceBefore ? ' ' : '') + finalText + (needSpaceAfter ? ' ' : '');

        textarea.value = before + insertText + after;

        const newCursorPos = pos + insertText.length;
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = newCursorPos;

        debugLog('AI voice input: ' + finalText);
        if (statusEl) {
            statusEl.textContent = 'タップで音声入力';
            statusEl.style.color = '#888';
        }
    } else {
        debugLog('AI voice input: no text');
        if (statusEl) {
            statusEl.textContent = 'タップで音声入力';
            statusEl.style.color = '#888';
        }
    }

    aiVoiceFinalText = '';
    aiVoiceInterimText = '';

    // WebRTCマイクを再開
    if (typeof resumeWebRTCMicrophone === 'function') {
        resumeWebRTCMicrophone();
    }
}

// ========== Initialization ==========

function initAIAssistant() {
    const voiceBtn = document.getElementById('aiVoiceInputBtn');
    const status = document.getElementById('aiMicStatus');

    if (!voiceBtn) {
        debugLog('AI voice button not found');
        return;
    }

    // オンデマンドマイク実装により、PTT未使用時はマイクが解放されているため
    // モバイルでもSpeechRecognitionが使用可能になった（はず）

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        voiceBtn.disabled = true;
        voiceBtn.textContent = '非対応';
        if (status) {
            status.textContent = '音声認識非対応';
            status.style.color = '#ff4757';
        }
        debugLog('SpeechRecognition not supported');
        return;
    }

    debugLog('AI assistant initializing...');

    // Mouse events (with document-level mouseup listener)
    const handleMouseUp = () => {
        document.removeEventListener('mouseup', handleMouseUp);
        if (aiIsListening) stopAISpeechRecognition();
    };

    voiceBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startAISpeechRecognition();
        document.addEventListener('mouseup', handleMouseUp);
    });

    // Touch events (mobile)
    voiceBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        debugLog('AI voice touchstart');
        startAISpeechRecognition();
    }, { passive: false });
    voiceBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        debugLog('AI voice touchend');
        if (aiIsListening) stopAISpeechRecognition();
    }, { passive: false });
    voiceBtn.addEventListener('touchcancel', (e) => {
        debugLog('AI voice touchcancel');
        if (aiIsListening) stopAISpeechRecognition();
    });

    // Textarea: Ctrl+Enter to send
    const textarea = document.getElementById('aiQueryInput');
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            sendAIQuery();
        }
    });

    // 初期状態を表示
    if (status) {
        status.textContent = 'タップで音声入力';
        status.style.color = '#888';
    }

    debugLog('AI assistant initialized');
}

// Initialize when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
    initAIAssistant();
});

// Hook into stream.js message handler
// This function is called from stream.js when AI-related messages are received
function processAIMessage(data) {
    if (data.type === 'ai_response') {
        handleAIResponse(data);
        return true;
    } else if (data.type === 'ai_tts_stopped') {
        handleAITTSStopped(data);
        return true;
    }
    return false;
}
