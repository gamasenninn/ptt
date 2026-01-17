/**
 * API エンドポイントのテスト
 * Phase 3: Express HTTP エンドポイントのテスト
 */

const request = require('supertest');
const express = require('express');
const { PTTManager } = require('../server');

// テスト用アプリケーション作成
function createTestApp() {
    const app = express();
    app.use(express.json());

    const pttManager = new PTTManager();
    const clients = new Map();
    const startTime = Date.now();

    // broadcastPttStatus のモック
    const broadcastPttStatus = jest.fn();

    // VOX API
    app.post('/api/vox/on', (req, res) => {
        if (pttManager.requestFloor('external')) {
            broadcastPttStatus();
            res.json({ success: true });
        } else {
            res.json({ success: false, reason: 'floor_busy' });
        }
    });

    app.post('/api/vox/off', (req, res) => {
        if (pttManager.releaseFloor('external')) {
            broadcastPttStatus();
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    });

    // セッション認証のモック（常に認証済みとする）
    const requireAuth = (req, res, next) => next();

    // Dashboard API
    app.get('/api/dash/status', requireAuth, (req, res) => {
        const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);
        const mem = process.memoryUsage();
        res.json({
            success: true,
            uptime: uptimeSeconds,
            connectedClients: clients.size,
            memoryUsage: {
                heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
                heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
                rss: Math.round(mem.rss / 1024 / 1024)
            }
        });
    });

    app.get('/api/dash/ptt', requireAuth, (req, res) => {
        const state = pttManager.getState();
        let currentSpeaker = null;
        let speakerDisplayName = null;
        let source = null;

        if (pttManager.currentSpeaker) {
            currentSpeaker = pttManager.currentSpeaker;
            if (currentSpeaker === 'external') {
                speakerDisplayName = 'Analog Transceiver';
                source = 'external';
            } else {
                const client = clients.get(currentSpeaker);
                speakerDisplayName = client ? client.displayName : currentSpeaker;
                source = 'web';
            }
        }

        res.json({
            success: true,
            state,
            currentSpeaker,
            speakerDisplayName,
            source
        });
    });

    app.post('/api/dash/ptt/release', requireAuth, (req, res) => {
        if (pttManager.currentSpeaker) {
            const releasedSpeaker = pttManager.currentSpeaker;
            pttManager.currentSpeaker = null;
            pttManager.speakerStartTime = null;
            broadcastPttStatus();
            res.json({ success: true, releasedSpeaker });
        } else {
            res.json({ success: false, reason: 'no_active_speaker' });
        }
    });

    return { app, pttManager, broadcastPttStatus, clients };
}

describe('VOX API', () => {
    let app, pttManager, broadcastPttStatus;

    beforeEach(() => {
        const testApp = createTestApp();
        app = testApp.app;
        pttManager = testApp.pttManager;
        broadcastPttStatus = testApp.broadcastPttStatus;
    });

    describe('POST /api/vox/on', () => {
        test('idle状態でPTT取得成功', async () => {
            const res = await request(app)
                .post('/api/vox/on')
                .expect('Content-Type', /json/)
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(pttManager.currentSpeaker).toBe('external');
            expect(broadcastPttStatus).toHaveBeenCalledTimes(1);
        });

        test('busy状態でPTT取得失敗', async () => {
            // 先にWebクライアントがPTT取得
            pttManager.requestFloor('web-client-1');

            const res = await request(app)
                .post('/api/vox/on')
                .expect(200);

            expect(res.body.success).toBe(false);
            expect(res.body.reason).toBe('floor_busy');
            expect(pttManager.currentSpeaker).toBe('web-client-1');
        });

        test('連続呼び出しで2回目は失敗', async () => {
            await request(app).post('/api/vox/on').expect(200);

            const res = await request(app)
                .post('/api/vox/on')
                .expect(200);

            expect(res.body.success).toBe(false);
        });
    });

    describe('POST /api/vox/off', () => {
        test('external送信中に解放成功', async () => {
            pttManager.requestFloor('external');

            const res = await request(app)
                .post('/api/vox/off')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(pttManager.currentSpeaker).toBeNull();
            expect(pttManager.getState()).toBe('idle');
        });

        test('他のクライアントが送信中は解放失敗', async () => {
            pttManager.requestFloor('web-client-1');

            const res = await request(app)
                .post('/api/vox/off')
                .expect(200);

            expect(res.body.success).toBe(false);
            expect(pttManager.currentSpeaker).toBe('web-client-1');
        });

        test('idle状態で解放は失敗', async () => {
            const res = await request(app)
                .post('/api/vox/off')
                .expect(200);

            expect(res.body.success).toBe(false);
        });
    });

    describe('VOX on/off シーケンス', () => {
        test('on → off → on の連続操作', async () => {
            // ON
            let res = await request(app).post('/api/vox/on');
            expect(res.body.success).toBe(true);

            // OFF
            res = await request(app).post('/api/vox/off');
            expect(res.body.success).toBe(true);

            // ON again
            res = await request(app).post('/api/vox/on');
            expect(res.body.success).toBe(true);

            expect(broadcastPttStatus).toHaveBeenCalledTimes(3);
        });
    });
});

describe('Dashboard API', () => {
    let app, pttManager, broadcastPttStatus, clients;

    beforeEach(() => {
        const testApp = createTestApp();
        app = testApp.app;
        pttManager = testApp.pttManager;
        broadcastPttStatus = testApp.broadcastPttStatus;
        clients = testApp.clients;
    });

    describe('GET /api/dash/status', () => {
        test('サーバーステータスを返す', async () => {
            const res = await request(app)
                .get('/api/dash/status')
                .expect('Content-Type', /json/)
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body).toHaveProperty('uptime');
            expect(res.body).toHaveProperty('connectedClients');
            expect(res.body).toHaveProperty('memoryUsage');
            expect(res.body.memoryUsage).toHaveProperty('heapUsed');
        });

        test('connectedClientsが正確', async () => {
            clients.set('client1', { displayName: 'Client 1' });
            clients.set('client2', { displayName: 'Client 2' });

            const res = await request(app)
                .get('/api/dash/status')
                .expect(200);

            expect(res.body.connectedClients).toBe(2);
        });
    });

    describe('GET /api/dash/ptt', () => {
        test('idle状態を返す', async () => {
            const res = await request(app)
                .get('/api/dash/ptt')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.state).toBe('idle');
            expect(res.body.currentSpeaker).toBeNull();
        });

        test('external送信中の状態を返す', async () => {
            pttManager.requestFloor('external');

            const res = await request(app)
                .get('/api/dash/ptt')
                .expect(200);

            expect(res.body.state).toBe('transmitting');
            expect(res.body.currentSpeaker).toBe('external');
            expect(res.body.speakerDisplayName).toBe('Analog Transceiver');
            expect(res.body.source).toBe('external');
        });

        test('Webクライアント送信中の状態を返す', async () => {
            clients.set('abc123', { displayName: 'Test User' });
            pttManager.requestFloor('abc123');

            const res = await request(app)
                .get('/api/dash/ptt')
                .expect(200);

            expect(res.body.state).toBe('transmitting');
            expect(res.body.currentSpeaker).toBe('abc123');
            expect(res.body.speakerDisplayName).toBe('Test User');
            expect(res.body.source).toBe('web');
        });
    });

    describe('POST /api/dash/ptt/release', () => {
        test('PTT強制解放成功', async () => {
            pttManager.requestFloor('client1');

            const res = await request(app)
                .post('/api/dash/ptt/release')
                .expect(200);

            expect(res.body.success).toBe(true);
            expect(res.body.releasedSpeaker).toBe('client1');
            expect(pttManager.getState()).toBe('idle');
        });

        test('idle状態では解放失敗', async () => {
            const res = await request(app)
                .post('/api/dash/ptt/release')
                .expect(200);

            expect(res.body.success).toBe(false);
            expect(res.body.reason).toBe('no_active_speaker');
        });
    });
});
