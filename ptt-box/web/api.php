<?php
/**
 * SRT Viewer API
 *
 * GET  ?action=list           : SRTファイル一覧取得
 * GET  ?action=get&file=xxx   : SRT内容取得
 * POST action=save            : SRT保存
 */

header('Content-Type: application/json; charset=utf-8');

// Autoload
require_once __DIR__ . '/src/SrtRepository.php';
require_once __DIR__ . '/src/SrtService.php';

// Configuration
$recordingsDir = getenv('RECORDINGS_DIR') ?: __DIR__ . '/../recordings';
$historyDir = $recordingsDir . '/history';

// Initialize
$repository = new SrtRepository($recordingsDir, $historyDir);
$service = new SrtService($repository);

// Get action
$action = isset($_GET['action']) ? $_GET['action'] : '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = isset($_POST['action']) ? $_POST['action'] : '';
}

try {
    switch ($action) {
        case 'list':
            $files = $service->getRecentFiles(100);
            echo json_encode(array(
                'success' => true,
                'files' => $files,
            ));
            break;

        case 'get':
            $filename = isset($_GET['file']) ? $_GET['file'] : '';
            if (empty($filename)) {
                throw new Exception('File parameter is required');
            }
            $file = $service->getFileWithContent($filename);
            echo json_encode(array(
                'success' => true,
                'file' => $file,
            ));
            break;

        case 'save':
            $filename = isset($_POST['file']) ? $_POST['file'] : '';
            $content = isset($_POST['content']) ? $_POST['content'] : '';

            if (empty($filename)) {
                throw new Exception('File parameter is required');
            }
            if (empty($content)) {
                throw new Exception('Content parameter is required');
            }

            $result = $service->updateSrt($filename, $content);
            echo json_encode(array(
                'success' => $result,
                'message' => $result ? 'Saved successfully' : 'Save failed',
            ));
            break;

        default:
            throw new Exception('Invalid action');
    }
} catch (Exception $e) {
    http_response_code(400);
    echo json_encode(array(
        'success' => false,
        'error' => $e->getMessage(),
    ));
}
