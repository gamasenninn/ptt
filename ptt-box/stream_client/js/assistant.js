// AI Assistant integration for Webトランシーバー
// HTTP SSEで動作（WebSocket/WebRTC接続不要）

// AI Voice input state
let aiRecognition = null;
let aiIsListening = false;
let aiRecognitionReady = false;
let aiVoiceFinalText = '';
let aiVoiceInterimText = '';
let aiSavedCursorPos = 0;
let aiLastAddedTranscript = '';  // Android重複防止用
let aiVoiceTimeout = null;

// AI Streaming state
let aiStreamingMessage = null;
let aiStreamingText = '';
let aiStreamAbortController = null;  // HTTP SSEストリーミング中断用

// Chat history persistence
const AI_CHAT_STORAGE_KEY = 'aiChatHistory';
const AI_CHAT_MAX_MESSAGES = 50;
let aiChatHistory = [];

// TTS playback state
let aiTTSPlaying = false;

// Edge TTS state
let edgeTTSAudio = null;     // 現在再生中のAudio要素（停止用）

// Client TTS streaming state
let aiClientTTSBuffer = '';        // テキストデルタの蓄積バッファ
let aiClientTTSQueue = [];         // 読み上げ待ちの文キュー
let aiClientTTSSpeaking = false;   // 現在読み上げ中かどうか
let aiClientTTSInCodeBlock = false; // コードブロック内フラグ（```で切替）

// marked.js initialization
if (typeof marked !== 'undefined') {
    marked.setOptions({
        breaks: true,
        gfm: true
    });
}

// ========== AI Query Functions ==========

async function sendAIQuery() {
    const textarea = document.getElementById('aiQueryInput');
    const query = textarea.value.trim();
    if (!query) return;

    // Add user message to chat
    addAIChatMessage('user', query, false);

    // Clear input
    textarea.value = '';

    // クライアントTTSリセット（前回の読み上げを停止）
    aiClientTTSBuffer = '';
    aiClientTTSQueue = [];
    aiClientTTSSpeaking = false;
    aiClientTTSInCodeBlock = false;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (edgeTTSAudio) { edgeTTSAudio.pause(); edgeTTSAudio = null; }

    // 前回のストリーミングを中断
    if (aiStreamAbortController) {
        aiStreamAbortController.abort();
        aiStreamAbortController = null;
    }

    // Initialize streaming state
    aiStreamingText = '';
    aiStreamingMessage = addAIChatMessage('ai streaming', '');
    aiStreamingMessage.id = 'aiStreamingMessage';
    updateStreamingStatus('thinking');

    // Get TTS mode from settings
    // WebSocket未接続時はサーバーTTSが使えないため、edge/clientにフォールバック
    let ttsMode = typeof getTtsMode === 'function' ? getTtsMode() : 'edge';
    const wsConnected = typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN;
    if (!wsConnected && ttsMode === 'server') {
        ttsMode = 'edge';
    }

    debugLog('AI query (HTTP SSE): ' + query.substring(0, 50) + '... (tts_mode=' + ttsMode + ')');

    // HTTP SSEでストリーミング受信
    aiStreamAbortController = new AbortController();

    try {
        const res = await fetch('/api/ai/query_stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, tts_mode: ttsMode }),
            signal: aiStreamAbortController.signal
        });

        if (!res.ok) {
            throw new Error('HTTP ' + res.status + ': ' + res.statusText);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const eventData = JSON.parse(line.slice(6));
                        // SSEではtype直接、WSではeventTypeにリネームされていた
                        // handleAIStreamEventはeventTypeを参照するので変換
                        handleAIStreamEvent({
                            ...eventData,
                            eventType: eventData.type
                        });
                    } catch (parseError) {
                        // JSONパースエラーは無視
                    }
                }
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            debugLog('AI query aborted');
            return;
        }
        debugLog('AI query error: ' + e.message);
        if (aiStreamingMessage) {
            aiStreamingMessage.classList.remove('streaming');
            aiStreamingMessage.classList.add('error');
            const content = aiStreamingMessage.querySelector('.content');
            if (content) {
                content.textContent = 'エラー: ' + e.message;
            }
            aiStreamingMessage = null;
            aiStreamingText = '';
        }
    } finally {
        aiStreamAbortController = null;
    }
}

// Update streaming message status
function updateStreamingStatus(status, toolName) {
    if (!aiStreamingMessage) return;

    const content = aiStreamingMessage.querySelector('.content');
    if (!content) return;

    if (status === 'thinking') {
        content.innerHTML = '<span class="ai-status">考え中<span class="ai-thinking-dots"><span>.</span><span>.</span><span>.</span></span></span>';
    } else if (status === 'tool_start') {
        const displayName = toolName || 'ツール';
        content.innerHTML = '<span class="ai-status">' + escapeHtmlAI(displayName) + ' を実行中<span class="ai-thinking-dots"><span>.</span><span>.</span><span>.</span></span></span>';
    } else if (status === 'streaming') {
        // テキストストリーミング中は何もしない（appendStreamingText で処理）
    }
}

// Append text to streaming message
function appendStreamingText(delta) {
    if (!aiStreamingMessage) return;

    aiStreamingText += delta;

    const content = aiStreamingMessage.querySelector('.content');
    if (!content) return;

    // マークダウンをレンダリング
    if (typeof marked !== 'undefined') {
        content.innerHTML = marked.parse(aiStreamingText);
    } else {
        content.innerHTML = escapeHtmlAI(aiStreamingText);
    }

    // スクロール
    const container = document.getElementById('aiChatContainer');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

// Finalize streaming message
function finalizeStreamingMessage(response) {
    if (!aiStreamingMessage) return;

    const content = aiStreamingMessage.querySelector('.content');
    if (!content) return;

    // 最終応答をマークダウンでレンダリング
    if (typeof marked !== 'undefined') {
        content.innerHTML = marked.parse(response);
    } else {
        content.innerHTML = escapeHtmlAI(response);
    }

    // ストリーミングクラスを削除
    aiStreamingMessage.classList.remove('streaming');
    aiStreamingMessage.removeAttribute('id');

    // スクロール
    const container = document.getElementById('aiChatContainer');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }

    // ストリーミング完了した応答を保存
    saveAIChatMessage('ai', response, true);

    // 状態をリセット
    aiStreamingMessage = null;
    aiStreamingText = '';

    debugLog('AI streaming completed');
}

function stopAITTS() {
    // クライアント側TTS（speechSynthesis）を停止
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }

    // Edge TTS audio停止
    if (edgeTTSAudio) {
        edgeTTSAudio.pause();
        edgeTTSAudio = null;
    }

    // クライアントTTSキューをリセット
    aiClientTTSBuffer = '';
    aiClientTTSQueue = [];
    aiClientTTSSpeaking = false;

    // 進行中のSSEストリーミングを中断
    if (aiStreamAbortController) {
        aiStreamAbortController.abort();
        aiStreamAbortController = null;
    }

    // クライアント側audio要素を停止
    const audio = document.getElementById('p2p-audio-server');
    if (audio) {
        audio.pause();
    }

    // サーバー側TTS停止リクエスト（WebSocket or HTTP）
    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ai_stop_tts' }));
    } else {
        // HTTP fallback
        fetch('/api/ai/stop_tts', { method: 'POST' }).catch(() => {});
    }

    aiTTSPlaying = false;
    debugLog('AI TTS stopped');
}

function setAITTSPlaying(playing) {
    aiTTSPlaying = playing;
    // 新規TTS開始時にpause()済みのaudio要素を再開
    if (playing) {
        const audio = document.getElementById('p2p-audio-server');
        if (audio && audio.paused) {
            audio.play().catch(e => debugLog('TTS audio resume error: ' + e.message));
        }
    }
}

function clearAIChat() {
    const container = document.getElementById('aiChatContainer');
    container.innerHTML = '<div class="ai-chat-empty">AIに質問してみましょう...</div>';
    aiChatHistory = [];
    localStorage.removeItem(AI_CHAT_STORAGE_KEY);
}

// ========== Voice Input Refinement ==========

async function refineVoiceInput() {
    const textarea = document.getElementById('aiQueryInput');
    const text = textarea.value.trim();
    if (!text) return;

    const btn = document.getElementById('aiRefineBtn');
    btn.textContent = '整形中...';
    btn.disabled = true;

    try {
        const res = await fetch('/api/refine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (data.refined) {
            textarea.value = data.refined;
        }
    } catch (e) {
        debugLog('Refine error: ' + e.message);
    } finally {
        btn.textContent = '✨ 整形';
        btn.disabled = false;
    }
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

    const cleaned = cleanTextForTTS(text);
    if (!cleaned) return;

    const utterance = new SpeechSynthesisUtterance(cleaned);
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

// ========== Edge TTS Functions ==========

async function playEdgeTTS(text) {
    const voice = localStorage.getItem('edge_tts_voice') || 'ja-JP-NanamiNeural';
    debugLog('Edge TTS: synthesizing "' + text.substring(0, 30) + '..." voice=' + voice);

    const resp = await fetch('/api/tts/edge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice })
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error('Edge TTS server error: ' + resp.status + ' ' + err);
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);

    return new Promise((resolve, reject) => {
        edgeTTSAudio = new Audio(url);
        edgeTTSAudio.onended = () => {
            URL.revokeObjectURL(url);
            edgeTTSAudio = null;
            resolve();
        };
        edgeTTSAudio.onerror = (e) => {
            URL.revokeObjectURL(url);
            edgeTTSAudio = null;
            reject(new Error('Audio playback error'));
        };
        edgeTTSAudio.play().catch(reject);
    });
}

// TTS用にテキストからマークダウン記号・URLを除去（Python版 clean_text_for_tts と同等）
function cleanTextForTTS(text) {
    // マークダウンリンク [text](url) → text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // コードブロック ```...``` → 除去
    text = text.replace(/```[\s\S]*?```/g, '');
    // 裸のURL
    text = text.replace(/https?:\/\/\S+/g, '');
    // 見出し記号 (### text → text)
    text = text.replace(/^#{1,6}\s+/gm, '');
    // 太字・斜体 (**text** or *text* → text)
    text = text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
    // リスト記号 (- text → text)
    text = text.replace(/^\s*[-*+]\s+/gm, '');
    // 番号リスト (1. text → text)
    text = text.replace(/^\s*\d+\.\s+/gm, '');
    // インラインコード (`code` → code)
    text = text.replace(/`([^`]+)`/g, '$1');
    // 連続空白を整理
    text = text.replace(/ {2,}/g, ' ');
    return text.trim();
}

// Flush complete sentences from client TTS buffer into the queue
function flushClientTTSSentences() {
    const sentenceEnd = /[。！？!?\n]/;
    let lastIndex = 0;
    for (let i = 0; i < aiClientTTSBuffer.length; i++) {
        if (sentenceEnd.test(aiClientTTSBuffer[i])) {
            const raw = aiClientTTSBuffer.substring(lastIndex, i + 1).trim();
            lastIndex = i + 1;

            // コードブロック開閉の検出（```を含む行でトグル）
            if (raw.includes('```')) {
                aiClientTTSInCodeBlock = !aiClientTTSInCodeBlock;
                continue;  // ```行自体はスキップ
            }

            // コードブロック内はスキップ
            if (aiClientTTSInCodeBlock) continue;

            const sentence = cleanTextForTTS(raw);
            if (sentence) {
                aiClientTTSQueue.push(sentence);
            }
        }
    }
    aiClientTTSBuffer = aiClientTTSBuffer.substring(lastIndex);
}

// Process client TTS queue one sentence at a time
function processClientTTSQueue() {
    if (aiClientTTSSpeaking || aiClientTTSQueue.length === 0) return;

    const ttsMode = typeof getTtsMode === 'function' ? getTtsMode() : 'client';
    const sentence = aiClientTTSQueue.shift();
    aiClientTTSSpeaking = true;

    if (ttsMode === 'edge') {
        playEdgeTTS(sentence).then(() => {
            aiClientTTSSpeaking = false;
            processClientTTSQueue();
        }).catch((e) => {
            debugLog('Edge TTS error: ' + (e && e.message || e));
            aiClientTTSSpeaking = false;
            processClientTTSQueue();
        });
    } else {
        // Web Speech API (既存)
        const utterance = new SpeechSynthesisUtterance(sentence);
        utterance.lang = 'ja-JP';
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        utterance.onend = () => {
            aiClientTTSSpeaking = false;
            processClientTTSQueue();
        };
        utterance.onerror = () => {
            aiClientTTSSpeaking = false;
            processClientTTSQueue();
        };

        speechSynthesis.speak(utterance);
    }
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

    // ストリーミング中・一時的なメッセージは保存しない
    if (type === 'user' || type === 'ai') {
        saveAIChatMessage(type, content, isMarkdown);
    }

    return message;
}

function escapeHtmlAI(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== Chat History Persistence ==========

function saveAIChatMessage(type, content, isMarkdown) {
    aiChatHistory.push({ type, content, isMarkdown });
    if (aiChatHistory.length > AI_CHAT_MAX_MESSAGES) {
        aiChatHistory = aiChatHistory.slice(-AI_CHAT_MAX_MESSAGES);
    }
    try {
        localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(aiChatHistory));
    } catch (e) {
        debugLog('Chat history save error: ' + e.message);
    }
}

function loadAIChatHistory() {
    try {
        const saved = localStorage.getItem(AI_CHAT_STORAGE_KEY);
        if (!saved) return;
        aiChatHistory = JSON.parse(saved);
        if (!Array.isArray(aiChatHistory) || aiChatHistory.length === 0) {
            aiChatHistory = [];
            return;
        }

        const container = document.getElementById('aiChatContainer');
        const empty = container.querySelector('.ai-chat-empty');
        if (empty) empty.remove();

        for (const msg of aiChatHistory) {
            const message = document.createElement('div');
            message.className = 'ai-chat-message ' + msg.type;

            const roleText = msg.type === 'user' ? 'あなた' : 'AI';
            let contentHtml;
            if (msg.isMarkdown && typeof marked !== 'undefined') {
                contentHtml = marked.parse(msg.content);
            } else {
                contentHtml = escapeHtmlAI(msg.content);
            }

            message.innerHTML = '<div class="role">' + roleText + '</div><div class="content">' + contentHtml + '</div>';
            container.appendChild(message);
        }

        container.scrollTop = container.scrollHeight;
        debugLog('Chat history restored: ' + aiChatHistory.length + ' messages');
    } catch (e) {
        debugLog('Chat history load error: ' + e.message);
        aiChatHistory = [];
    }
}

// ========== Voice Input Functions ==========

// 蓄積テキスト(a)の末尾と新テキスト(b)の先頭の重複を検出
// 例: a="何時か", b="何時かそして" → overlap=3
function findAIVoiceOverlap(a, b) {
    if (!a || !b) return 0;
    const maxLen = Math.min(a.length, b.length);
    for (let len = maxLen; len >= 3; len--) {
        if (a.endsWith(b.substring(0, len))) {
            return len;
        }
    }
    return 0;
}

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
                    if (transcript && transcript !== aiLastAddedTranscript) {
                        // モバイル再起動時の重複防止: 蓄積テキスト末尾との重複を検出
                        const overlap = findAIVoiceOverlap(aiVoiceFinalText, transcript);
                        if (overlap > 0) {
                            const remainder = transcript.substring(overlap);
                            if (remainder) {
                                aiVoiceFinalText += remainder;
                                debugLog('AI voice overlap (' + overlap + ' chars), added remainder');
                            }
                        } else {
                            aiVoiceFinalText += transcript;
                        }
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
        const sendBtn = document.getElementById('aiSendBtn');
        if (sendBtn) sendBtn.disabled = true;
        if (statusEl) {
            statusEl.textContent = '音声認識中...';
            statusEl.style.color = '#2ed573';
        }
        debugLog('AI voice input started');

        // 30秒タイムアウト
        aiVoiceTimeout = setTimeout(() => {
            if (aiIsListening) {
                debugLog('AI voice input timeout');
                stopAISpeechRecognition();
            }
        }, 30000);
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
    if (aiVoiceTimeout) {
        clearTimeout(aiVoiceTimeout);
        aiVoiceTimeout = null;
    }
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
    const sendBtn = document.getElementById('aiSendBtn');
    if (sendBtn) sendBtn.disabled = false;

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

    // トグル方式: 1回押して開始、もう1回押して確定
    voiceBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (aiIsListening) {
            stopAISpeechRecognition();
        } else {
            startAISpeechRecognition();
        }
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
    loadAIChatHistory();
    initAIAssistant();
});

// Hook into stream.js message handler
// This function is called from stream.js when AI-related messages are received
function processAIMessage(data) {
    if (data.type === 'ai_response') {
        handleAIResponse(data);
        return true;
    } else if (data.type === 'ai_stream_event') {
        handleAIStreamEvent(data);
        return true;
    } else if (data.type === 'ai_tts_stopped') {
        handleAITTSStopped(data);
        return true;
    }
    return false;
}

// Handle streaming events from AI Assistant
function handleAIStreamEvent(data) {
    // eventType にはPythonから送られたイベントタイプが入る
    const eventType = data.eventType;

    if (eventType === 'error') {
        // エラーイベント
        const errorMsg = data.message || 'Unknown error';
        debugLog('AI stream error: ' + errorMsg);
        if (aiStreamingMessage) {
            aiStreamingMessage.classList.remove('streaming');
            aiStreamingMessage.classList.add('error');
            const content = aiStreamingMessage.querySelector('.content');
            if (content) {
                content.textContent = 'エラー: ' + errorMsg;
            }
        }
        aiStreamingMessage = null;
        aiStreamingText = '';
        return;
    }

    if (eventType === 'thinking') {
        updateStreamingStatus('thinking');
        debugLog('AI thinking...');
    } else if (eventType === 'tool_start') {
        updateStreamingStatus('tool_start', data.name);
        debugLog('AI tool start: ' + (data.name || 'unknown'));
    } else if (eventType === 'tool_end') {
        // ツール完了後は次のアクションを待機
        debugLog('AI tool end: ' + (data.name || 'unknown'));
    } else if (eventType === 'text') {
        // テキストデルタを追加
        if (data.delta) {
            appendStreamingText(data.delta);
            // テキスト生成開始 = TTS再生中 → 停止ボタン表示
            if (!aiTTSPlaying) {
                setAITTSPlaying(true);
                // P2Pオーディオ診断
                const audio = document.getElementById('p2p-audio-server');
                if (audio) {
                    const track = audio.srcObject?.getAudioTracks()[0];
                    debugLog('[TTS診断] audio: paused=' + audio.paused + ' muted=' + audio.muted +
                        ' volume=' + audio.volume + ' srcObject=' + !!audio.srcObject +
                        ' streamActive=' + audio.srcObject?.active +
                        ' trackState=' + (track?.readyState || 'none') +
                        ' trackEnabled=' + (track?.enabled ?? 'none'));
                } else {
                    debugLog('[TTS診断] p2p-audio-server NOT FOUND');
                }
            }

            // クライアントTTSストリーミング: 文単位で逐次読み上げ
            const ttsMode = typeof getTtsMode === 'function' ? getTtsMode() : 'server';
            if (ttsMode === 'client' || ttsMode === 'edge') {
                aiClientTTSBuffer += data.delta;
                flushClientTTSSentences();
                processClientTTSQueue();
            }
        }
    } else if (eventType === 'done') {
        // 完了イベント
        finalizeStreamingMessage(data.response || aiStreamingText);

        // TTS再生状態をリセット
        setAITTSPlaying(false);

        // クライアントTTS: バッファに残った未完成文も読み上げ
        const ttsMode = typeof getTtsMode === 'function' ? getTtsMode() : 'server';
        if (ttsMode === 'client' || ttsMode === 'edge') {
            if (aiClientTTSBuffer.trim()) {
                const remaining = cleanTextForTTS(aiClientTTSBuffer);
                if (remaining) aiClientTTSQueue.push(remaining);
                aiClientTTSBuffer = '';
            }
            processClientTTSQueue();
        }
    }
}
