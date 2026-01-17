/**
 * PTTManager クラスのテスト
 * Phase 2: 状態管理クラスのテスト
 */

const { PTTManager } = require('../server');

describe('PTTManager', () => {
    let manager;

    beforeEach(() => {
        manager = new PTTManager();
    });

    describe('初期状態', () => {
        test('初期状態はidle', () => {
            expect(manager.getState()).toBe('idle');
        });

        test('初期状態ではcurrentSpeakerはnull', () => {
            expect(manager.currentSpeaker).toBeNull();
        });
    });

    describe('requestFloor', () => {
        test('idle状態でrequestFloor → true', () => {
            const result = manager.requestFloor('client1');
            expect(result).toBe(true);
        });

        test('requestFloor成功後、状態がtransmittingになる', () => {
            manager.requestFloor('client1');
            expect(manager.getState()).toBe('transmitting');
        });

        test('requestFloor成功後、currentSpeakerが設定される', () => {
            manager.requestFloor('client1');
            expect(manager.currentSpeaker).toBe('client1');
        });

        test('requestFloor成功後、speakerStartTimeが設定される', () => {
            manager.requestFloor('client1');
            expect(manager.speakerStartTime).not.toBeNull();
            expect(typeof manager.speakerStartTime).toBe('number');
        });

        test('busy状態でrequestFloor → false', () => {
            manager.requestFloor('client1');
            const result = manager.requestFloor('client2');
            expect(result).toBe(false);
        });

        test('busy状態でrequestFloorしても状態は変わらない', () => {
            manager.requestFloor('client1');
            manager.requestFloor('client2');
            expect(manager.currentSpeaker).toBe('client1');
        });

        test('同じクライアントが再度requestFloor → false', () => {
            manager.requestFloor('client1');
            const result = manager.requestFloor('client1');
            expect(result).toBe(false);
        });
    });

    describe('releaseFloor', () => {
        test('正しいclientでreleaseFloor → true', () => {
            manager.requestFloor('client1');
            const result = manager.releaseFloor('client1');
            expect(result).toBe(true);
        });

        test('releaseFloor成功後、状態がidleに戻る', () => {
            manager.requestFloor('client1');
            manager.releaseFloor('client1');
            expect(manager.getState()).toBe('idle');
        });

        test('releaseFloor成功後、currentSpeakerがnullになる', () => {
            manager.requestFloor('client1');
            manager.releaseFloor('client1');
            expect(manager.currentSpeaker).toBeNull();
        });

        test('別のclientでreleaseFloor → false', () => {
            manager.requestFloor('client1');
            const result = manager.releaseFloor('client2');
            expect(result).toBe(false);
        });

        test('別のclientでreleaseFloorしても状態は変わらない', () => {
            manager.requestFloor('client1');
            manager.releaseFloor('client2');
            expect(manager.currentSpeaker).toBe('client1');
            expect(manager.getState()).toBe('transmitting');
        });

        test('idle状態でreleaseFloor → false', () => {
            const result = manager.releaseFloor('client1');
            expect(result).toBe(false);
        });
    });

    describe('checkTimeout', () => {
        test('タイムアウト前はnullを返す', () => {
            manager.requestFloor('client1');
            const result = manager.checkTimeout();
            expect(result).toBeNull();
        });

        test('idle状態ではnullを返す', () => {
            const result = manager.checkTimeout();
            expect(result).toBeNull();
        });

        test('タイムアウト超過でclientIdを返す', () => {
            manager.maxTransmitTime = 5000; // 5秒に設定
            manager.requestFloor('client1');
            // 過去の時刻を設定してタイムアウトをシミュレート
            manager.speakerStartTime = Date.now() - 6000; // 6秒前
            const result = manager.checkTimeout();
            expect(result).toBe('client1');
        });

        test('タイムアウト後、状態がidleに戻る', () => {
            manager.maxTransmitTime = 5000; // 5秒に設定
            manager.requestFloor('client1');
            manager.speakerStartTime = Date.now() - 6000; // 6秒前
            manager.checkTimeout();
            expect(manager.getState()).toBe('idle');
            expect(manager.currentSpeaker).toBeNull();
        });

        test('maxTransmitTime=0ではタイムアウト無効（常にnull）', () => {
            manager.maxTransmitTime = 0;
            manager.requestFloor('client1');
            manager.speakerStartTime = Date.now() - 1000000; // 非常に古い時刻
            const result = manager.checkTimeout();
            expect(result).toBeNull();
        });

        test('maxTransmitTime<0でもタイムアウト無効', () => {
            manager.maxTransmitTime = -1;
            manager.requestFloor('client1');
            manager.speakerStartTime = Date.now() - 1000000;
            const result = manager.checkTimeout();
            expect(result).toBeNull();
        });
    });

    describe('getState', () => {
        test('currentSpeakerがnullならidle', () => {
            manager.currentSpeaker = null;
            expect(manager.getState()).toBe('idle');
        });

        test('currentSpeakerがあればtransmitting', () => {
            manager.currentSpeaker = 'client1';
            expect(manager.getState()).toBe('transmitting');
        });
    });

    describe('状態遷移シナリオ', () => {
        test('連続した送信権の取得と解放', () => {
            // client1が取得
            expect(manager.requestFloor('client1')).toBe(true);
            expect(manager.getState()).toBe('transmitting');

            // client2が試みるが失敗
            expect(manager.requestFloor('client2')).toBe(false);

            // client1が解放
            expect(manager.releaseFloor('client1')).toBe(true);
            expect(manager.getState()).toBe('idle');

            // client2が取得成功
            expect(manager.requestFloor('client2')).toBe(true);
            expect(manager.currentSpeaker).toBe('client2');
        });

        test('タイムアウト後に別クライアントが取得可能', () => {
            manager.maxTransmitTime = 5000; // 5秒に設定
            manager.requestFloor('client1');
            // タイムアウトをシミュレート
            manager.speakerStartTime = Date.now() - 6000; // 6秒前
            manager.checkTimeout();

            // client2が取得可能
            expect(manager.requestFloor('client2')).toBe(true);
            expect(manager.currentSpeaker).toBe('client2');
        });
    });
});
