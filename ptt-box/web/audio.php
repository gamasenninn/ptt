<?php
/**
 * WAV file proxy
 * Serves WAV files from recordings directory
 */

$recordingsDir = getenv('RECORDINGS_DIR') ?: __DIR__ . '/../recordings';

$file = isset($_GET['file']) ? $_GET['file'] : '';

// Security: only allow rec_*.wav and web_*.wav (with optional clientId) files and prevent directory traversal
$file = basename($file);
if (!preg_match('/^(?:rec|web)_\d{8}_\d{6}(?:_\w+)?\.wav$/i', $file)) {
    http_response_code(400);
    exit('Invalid file name');
}

$filePath = $recordingsDir . '/' . $file;

if (!file_exists($filePath)) {
    http_response_code(404);
    exit('File not found');
}

// Serve the WAV file
header('Content-Type: audio/wav');
header('Content-Length: ' . filesize($filePath));
header('Accept-Ranges: bytes');

// Support range requests for seeking
if (isset($_SERVER['HTTP_RANGE'])) {
    $range = $_SERVER['HTTP_RANGE'];
    if (preg_match('/bytes=(\d+)-(\d*)/', $range, $matches)) {
        $start = intval($matches[1]);
        $end = $matches[2] !== '' ? intval($matches[2]) : filesize($filePath) - 1;
        $length = $end - $start + 1;

        http_response_code(206);
        header("Content-Range: bytes $start-$end/" . filesize($filePath));
        header("Content-Length: $length");

        $fp = fopen($filePath, 'rb');
        fseek($fp, $start);
        echo fread($fp, $length);
        fclose($fp);
        exit;
    }
}

readfile($filePath);
