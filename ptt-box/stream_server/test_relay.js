/**
 * USB RELAY X-RL2 テストプログラム
 *
 * Usage:
 *   node test_relay.js
 *   node test_relay.js COM4        # ポート指定
 */

const { SerialPort } = require('serialport');

const COM_PORT = process.argv[2] || 'COM3';
const BAUD_RATE = 9600;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log(`接続: ${COM_PORT}`);

    let port;
    try {
        port = new SerialPort({
            path: COM_PORT,
            baudRate: BAUD_RATE
        });
    } catch (e) {
        console.error(`エラー: ${e.message}`);
        process.exit(1);
    }

    await new Promise((resolve, reject) => {
        port.on('open', resolve);
        port.on('error', reject);
    });

    await sleep(500);

    // テスト: リレーA ON/OFF を3回繰り返す
    console.log('\n=== リレーA テスト ===');
    for (let i = 0; i < 3; i++) {
        console.log(`\n--- テスト ${i + 1} ---`);
        port.write('A1');
        console.log('リレーA ON');
        await sleep(2000);
        port.write('A0');
        console.log('リレーA OFF');
        await sleep(2000);
    }

    // テスト: リレーB ON/OFF を3回繰り返す
    console.log('\n=== リレーB テスト ===');
    for (let i = 0; i < 3; i++) {
        console.log(`\n--- テスト ${i + 1} ---`);
        port.write('B1');
        console.log('リレーB ON');
        await sleep(2000);
        port.write('B0');
        console.log('リレーB OFF');
        await sleep(2000);
    }

    port.close();
    console.log('\n完了');
}

main().catch(e => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
});
