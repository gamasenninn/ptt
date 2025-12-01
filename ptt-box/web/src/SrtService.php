<?php
/**
 * SrtService - SRT関連のビジネスロジックを担当
 */
class SrtService
{
    private $repository;

    /**
     * @param SrtRepository $repository
     */
    public function __construct(SrtRepository $repository)
    {
        $this->repository = $repository;
    }

    /**
     * 最新のSRTファイル一覧を取得
     *
     * @param int $limit 取得件数上限
     * @return array ファイル情報の配列
     */
    public function getRecentFiles($limit = 100)
    {
        $files = $this->repository->listSrtFiles($limit);
        $result = array();

        foreach ($files as $filename) {
            $result[] = array(
                'filename' => $filename,
                'datetime' => $this->extractDatetimeFromFilename($filename),
                'wavFile' => $this->repository->getWavPath($filename),
            );
        }

        return $result;
    }

    /**
     * ファイル名から日時を抽出
     *
     * @param string $filename rec_YYYYMMDD_HHMMSS.srt 形式
     * @return string|null YYYY-MM-DD HH:MM:SS形式、抽出できない場合はnull
     */
    public function extractDatetimeFromFilename($filename)
    {
        $basename = basename($filename, '.srt');

        // rec_YYYYMMDD_HHMMSS パターンにマッチ
        if (preg_match('/rec_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/', $basename, $matches)) {
            return sprintf(
                '%s-%s-%s %s:%s:%s',
                $matches[1], $matches[2], $matches[3],
                $matches[4], $matches[5], $matches[6]
            );
        }

        return null;
    }

    /**
     * SRTファイルの内容をパース
     *
     * @param string $content SRTファイルの内容
     * @return array セグメントの配列
     */
    public function parseSrt($content)
    {
        if (empty(trim($content))) {
            return array();
        }

        $segments = array();
        // SRTは空行で区切られている
        $blocks = preg_split('/\n\n+/', trim($content));

        foreach ($blocks as $block) {
            $lines = explode("\n", trim($block));

            if (count($lines) < 3) {
                continue;
            }

            // 1行目: インデックス番号
            $index = intval($lines[0]);

            // 2行目: タイムスタンプ
            $timeLine = $lines[1];
            if (preg_match('/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/', $timeLine, $timeMatches)) {
                $start = $timeMatches[1];
                $end = $timeMatches[2];
            } else {
                continue;
            }

            // 3行目以降: テキスト
            $textLines = array_slice($lines, 2);
            $text = implode("\n", $textLines);

            $segments[] = array(
                'index' => $index,
                'start' => $start,
                'end' => $end,
                'text' => $text,
            );
        }

        return $segments;
    }

    /**
     * ファイル内容とパース結果を含めて取得
     *
     * @param string $filename ファイル名
     * @return array ファイル情報
     */
    public function getFileWithContent($filename)
    {
        $content = $this->repository->getSrtContent($filename);
        $segments = $this->parseSrt($content);

        return array(
            'filename' => $filename,
            'datetime' => $this->extractDatetimeFromFilename($filename),
            'content' => $content,
            'segments' => $segments,
            'wavFile' => $this->repository->getWavPath($filename),
        );
    }

    /**
     * SRTファイルを更新
     *
     * @param string $filename ファイル名
     * @param string $content 新しい内容
     * @return bool 成功時true
     */
    public function updateSrt($filename, $content)
    {
        return $this->repository->saveSrtWithBackup($filename, $content);
    }
}
