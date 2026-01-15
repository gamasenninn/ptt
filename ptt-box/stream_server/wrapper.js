/**
 * 最小限のサーバーラッパー
 * server.jsが終了コード0で終了した場合、自動的に再起動する
 *
 * Usage: node wrapper.js
 */

const { spawn } = require('child_process');
const path = require('path');

const serverScript = path.join(__dirname, 'server.js');
let restartCount = 0;

function start() {
    console.log(`[wrapper] Starting server... (restart #${restartCount})`);

    const child = spawn('node', [serverScript], {
        stdio: 'inherit',
        cwd: __dirname
    });

    child.on('exit', (code, signal) => {
        if (code === 0) {
            // 正常終了 = 再起動要求
            restartCount++;
            console.log('[wrapper] Server exited normally, restarting in 1 second...');
            setTimeout(start, 1000);
        } else if (signal) {
            console.log(`[wrapper] Server killed by signal ${signal}`);
        } else {
            console.log(`[wrapper] Server exited with code ${code}, not restarting`);
        }
    });

    child.on('error', (err) => {
        console.error(`[wrapper] Failed to start server: ${err.message}`);
    });
}

// Ctrl+C で wrapper ごと終了
process.on('SIGINT', () => {
    console.log('\n[wrapper] Shutting down...');
    process.exit(1);
});

start();
