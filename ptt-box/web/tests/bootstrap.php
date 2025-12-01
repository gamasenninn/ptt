<?php
// Autoload classes
spl_autoload_register(function ($class) {
    $file = __DIR__ . '/../src/' . $class . '.php';
    if (file_exists($file)) {
        require_once $file;
    }
});

// Define test constants
define('TEST_RECORDINGS_DIR', __DIR__ . '/fixtures/recordings');
define('TEST_HISTORY_DIR', __DIR__ . '/fixtures/history');
