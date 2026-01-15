/**
 * Dashboard JavaScript
 */

class Dashboard {
    constructor() {
        this.token = localStorage.getItem('dashToken');
        this.refreshInterval = null;
        this.init();
    }

    init() {
        // 画面要素
        this.loginScreen = document.getElementById('login-screen');
        this.dashboardScreen = document.getElementById('dashboard-screen');

        // イベントリスナー
        document.getElementById('login-form').addEventListener('submit', (e) => this.handleLogin(e));
        document.getElementById('logout-btn').addEventListener('click', () => this.handleLogout());
        document.getElementById('restart-btn').addEventListener('click', () => this.handleRestart());
        document.getElementById('ptt-release-btn').addEventListener('click', () => this.handlePttRelease());

        // トークンがあれば検証
        if (this.token) {
            this.verifyToken();
        }
    }

    async verifyToken() {
        try {
            const res = await this.api('GET', '/api/dash/status');
            if (res.success) {
                this.showDashboard();
            } else {
                this.token = null;
                localStorage.removeItem('dashToken');
            }
        } catch (e) {
            this.token = null;
            localStorage.removeItem('dashToken');
        }
    }

    async handleLogin(e) {
        e.preventDefault();
        const password = document.getElementById('password').value;
        const errorEl = document.getElementById('login-error');

        try {
            const res = await fetch('/api/dash/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();

            if (data.success) {
                this.token = data.token;
                localStorage.setItem('dashToken', this.token);
                errorEl.textContent = '';
                this.showDashboard();
            } else {
                errorEl.textContent = 'パスワードが違います';
            }
        } catch (e) {
            errorEl.textContent = '接続エラー';
        }
    }

    async handleLogout() {
        try {
            await this.api('POST', '/api/dash/logout');
        } catch (e) {}
        this.token = null;
        localStorage.removeItem('dashToken');
        this.hideDashboard();
    }

    showDashboard() {
        this.loginScreen.classList.add('hidden');
        this.dashboardScreen.classList.remove('hidden');
        this.startRefresh();
    }

    hideDashboard() {
        this.dashboardScreen.classList.add('hidden');
        this.loginScreen.classList.remove('hidden');
        this.stopRefresh();
    }

    startRefresh() {
        this.refresh();
        this.refreshInterval = setInterval(() => this.refresh(), 5000);
    }

    stopRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    async refresh() {
        try {
            await Promise.all([
                this.refreshStatus(),
                this.refreshClients(),
                this.refreshPtt()
            ]);
            document.getElementById('last-update').textContent =
                `最終更新: ${new Date().toLocaleTimeString()}`;
        } catch (e) {
            console.error('Refresh error:', e);
        }
    }

    async refreshStatus() {
        const res = await this.api('GET', '/api/dash/status');
        if (res.success) {
            const s = res.status;
            document.getElementById('uptime').textContent = s.uptimeFormatted;
            document.getElementById('memory').textContent = `${s.memory.heapUsed}MB / ${s.memory.heapTotal}MB`;
            document.getElementById('client-count').textContent = s.clientCount;

            const speakerEl = document.getElementById('speaker-process');
            speakerEl.textContent = s.speakerProcess === 'running' ? '稼働中' : '停止';
            speakerEl.className = `value state-${s.speakerProcess}`;
        }
    }

    async refreshClients() {
        const res = await this.api('GET', '/api/dash/clients');
        if (res.success) {
            const tbody = document.getElementById('clients-tbody');
            if (res.clients.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3">接続なし</td></tr>';
            } else {
                tbody.innerHTML = res.clients.map(c => `
                    <tr>
                        <td>${c.clientId}</td>
                        <td>${c.displayName}</td>
                        <td class="state-${c.p2pState === 'connected' ? 'connected' : 'disconnected'}">${c.p2pState}</td>
                    </tr>
                `).join('');
            }
        }
    }

    async refreshPtt() {
        const res = await this.api('GET', '/api/dash/ptt');
        if (res.success) {
            const p = res.ptt;
            const stateEl = document.getElementById('ptt-state');
            stateEl.textContent = p.state === 'transmitting' ? '送信中' : '待機中';
            stateEl.className = `value state-${p.state}`;

            document.getElementById('ptt-speaker').textContent = p.speakerName || '-';
        }
    }

    async handleRestart() {
        if (!confirm('サーバーを再起動しますか？')) return;

        const btn = document.getElementById('restart-btn');
        btn.disabled = true;
        btn.textContent = '再起動中...';

        try {
            await this.api('POST', '/api/dash/restart');
        } catch (e) {
            // 接続が切れるのは正常
        }

        // サーバー再起動を待ってから再接続を試みる
        setTimeout(() => this.waitForRestart(), 2000);
    }

    async waitForRestart() {
        const btn = document.getElementById('restart-btn');
        btn.textContent = '復帰待機中...';

        // 最大30秒間、サーバー復帰を待つ
        for (let i = 0; i < 15; i++) {
            try {
                const res = await fetch('/api/dash/status', {
                    headers: { 'X-Dash-Token': this.token }
                });
                if (res.ok) {
                    // サーバー復帰、トークンは無効になっているので再ログイン
                    btn.disabled = false;
                    btn.textContent = 'サーバー再起動';
                    this.token = null;
                    localStorage.removeItem('dashToken');
                    this.hideDashboard();
                    alert('サーバーが再起動しました。再度ログインしてください。');
                    return;
                }
            } catch (e) {
                // まだ起動中
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        // タイムアウト
        btn.disabled = false;
        btn.textContent = 'サーバー再起動';
        alert('サーバーが再起動した可能性があります。ページを更新してください。');
    }

    async handlePttRelease() {
        if (!confirm('PTTを強制解放しますか？')) return;

        try {
            const res = await this.api('POST', '/api/dash/ptt/release');
            if (res.success) {
                alert('PTTを解放しました');
                this.refresh();
            }
        } catch (e) {
            alert('PTT解放エラー');
        }
    }

    async api(method, url) {
        const res = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Dash-Token': this.token
            }
        });

        if (res.status === 401) {
            this.token = null;
            localStorage.removeItem('dashToken');
            this.hideDashboard();
            throw new Error('Unauthorized');
        }

        return res.json();
    }
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    new Dashboard();
});
