<?php
/**
 * SrtRepository - SRTファイルの読み書き操作を担当
 */
class SrtRepository
{
    private $recordingsDir;
    private $historyDir;

    /**
     * @param string $recordingsDir SRTファイルが格納されているディレクトリ
     * @param string $historyDir バックアップファイルを保存するディレクトリ
     */
    public function __construct($recordingsDir, $historyDir)
    {
        $this->recordingsDir = rtrim($recordingsDir, '/\\');
        $this->historyDir = rtrim($historyDir, '/\\');
    }

    /**
     * SRTファイルの一覧を取得（日時降順）
     *
     * @param int $limit 取得件数上限
     * @return array ファイル名の配列
     */
    public function listSrtFiles($limit = 100)
    {
        $pattern = $this->recordingsDir . '/*.srt';
        $files = glob($pattern);

        if ($files === false) {
            return array();
        }

        // ファイル名のみを抽出
        $fileNames = array_map('basename', $files);

        // 日時部分でソート（rec_YYYYMMDD_HHMMSS または web_YYYYMMDD_HHMMSS）
        usort($fileNames, function($a, $b) {
            $dateA = $this->extractDatetimeForSort($a);
            $dateB = $this->extractDatetimeForSort($b);
            // 降順（新しい順）
            return strcmp($dateB, $dateA);
        });

        // 件数制限
        return array_slice($fileNames, 0, $limit);
    }

    /**
     * ファイル名から日時文字列を抽出（ソート用）
     *
     * @param string $filename ファイル名
     * @return string YYYYMMDD_HHMMSS形式、抽出できない場合は空文字
     */
    private function extractDatetimeForSort($filename)
    {
        // rec_YYYYMMDD_HHMMSS または web_YYYYMMDD_HHMMSS または web_YYYYMMDD_HHMMSS_CLIENTID
        if (preg_match('/(?:rec|web)_(\d{8}_\d{6})/', $filename, $matches)) {
            return $matches[1];
        }
        return '';
    }

    /**
     * SRTファイルの内容を取得
     *
     * @param string $filename ファイル名
     * @return string ファイル内容
     * @throws Exception ファイルが見つからない場合
     */
    public function getSrtContent($filename)
    {
        $filePath = $this->recordingsDir . '/' . basename($filename);

        if (!file_exists($filePath)) {
            throw new Exception('File not found: ' . $filename);
        }

        return file_get_contents($filePath);
    }

    /**
     * SRTファイルを保存（バックアップ付き）
     *
     * @param string $filename ファイル名
     * @param string $content 新しい内容
     * @return bool 成功時true
     */
    public function saveSrtWithBackup($filename, $content)
    {
        $filePath = $this->recordingsDir . '/' . basename($filename);

        // 既存ファイルがあればバックアップ
        if (file_exists($filePath)) {
            $this->createBackup($filename);
        }

        // 新しい内容を保存
        return file_put_contents($filePath, $content) !== false;
    }

    /**
     * バックアップファイルを作成
     *
     * @param string $filename ファイル名
     * @return bool 成功時true
     */
    private function createBackup($filename)
    {
        $sourcePath = $this->recordingsDir . '/' . basename($filename);
        $timestamp = date('Y-m-d_His');
        $backupPath = $this->historyDir . '/' . basename($filename) . '.' . $timestamp;

        // historyディレクトリがなければ作成
        if (!is_dir($this->historyDir)) {
            mkdir($this->historyDir, 0755, true);
        }

        return copy($sourcePath, $backupPath);
    }

    /**
     * SRTファイル名から対応するWAVファイル名を取得
     *
     * @param string $srtFilename SRTファイル名
     * @return string WAVファイル名
     */
    public function getWavPath($srtFilename)
    {
        $basename = basename($srtFilename, '.srt');
        return $basename . '.wav';
    }
}
