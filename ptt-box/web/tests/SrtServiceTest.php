<?php
use PHPUnit\Framework\TestCase;

class SrtServiceTest extends TestCase
{
    private $service;
    private $repository;

    protected function setUp(): void
    {
        $this->repository = new SrtRepository(TEST_RECORDINGS_DIR, TEST_HISTORY_DIR);
        $this->service = new SrtService($this->repository);
    }

    public function testGetRecentFiles()
    {
        $files = $this->service->getRecentFiles();

        $this->assertIsArray($files);
        $this->assertGreaterThanOrEqual(2, count($files));

        // Check structure
        $firstFile = $files[0];
        $this->assertArrayHasKey('filename', $firstFile);
        $this->assertArrayHasKey('datetime', $firstFile);
        $this->assertArrayHasKey('wavFile', $firstFile);
    }

    public function testGetRecentFilesAreSortedByDateDesc()
    {
        $files = $this->service->getRecentFiles();

        // 110000 should come before 100000
        $this->assertStringContainsString('110000', $files[0]['filename']);
        $this->assertStringContainsString('100000', $files[1]['filename']);
    }

    public function testParseSrt()
    {
        $srtContent = "1\n00:00:00,000 --> 00:00:02,000\nテスト音声1\n\n2\n00:00:02,000 --> 00:00:04,000\nテスト音声2\n";

        $parsed = $this->service->parseSrt($srtContent);

        $this->assertCount(2, $parsed);

        // Check first segment
        $this->assertEquals(1, $parsed[0]['index']);
        $this->assertEquals('00:00:00,000', $parsed[0]['start']);
        $this->assertEquals('00:00:02,000', $parsed[0]['end']);
        $this->assertEquals('テスト音声1', $parsed[0]['text']);

        // Check second segment
        $this->assertEquals(2, $parsed[1]['index']);
        $this->assertEquals('00:00:02,000', $parsed[1]['start']);
        $this->assertEquals('00:00:04,000', $parsed[1]['end']);
        $this->assertEquals('テスト音声2', $parsed[1]['text']);
    }

    public function testParseSrtWithMultilineText()
    {
        $srtContent = "1\n00:00:00,000 --> 00:00:02,000\n行1\n行2\n";

        $parsed = $this->service->parseSrt($srtContent);

        $this->assertCount(1, $parsed);
        $this->assertEquals("行1\n行2", $parsed[0]['text']);
    }

    public function testParseSrtEmpty()
    {
        $parsed = $this->service->parseSrt('');

        $this->assertCount(0, $parsed);
    }

    public function testParseSrtWithPeriodTimestamp()
    {
        // ピリオド区切りのタイムスタンプ形式に対応
        $srtContent = "1\n00:00:00.000 --> 00:00:02.000\nテスト\n";

        $parsed = $this->service->parseSrt($srtContent);

        $this->assertCount(1, $parsed);
        $this->assertEquals('00:00:00.000', $parsed[0]['start']);
        $this->assertEquals('00:00:02.000', $parsed[0]['end']);
        $this->assertEquals('テスト', $parsed[0]['text']);
    }

    public function testGetFileWithContent()
    {
        $file = $this->service->getFileWithContent('rec_20251201_100000.srt');

        $this->assertArrayHasKey('filename', $file);
        $this->assertArrayHasKey('content', $file);
        $this->assertArrayHasKey('segments', $file);
        $this->assertArrayHasKey('wavFile', $file);

        $this->assertEquals('rec_20251201_100000.srt', $file['filename']);
        $this->assertStringContainsString('テスト音声1', $file['content']);
        $this->assertCount(2, $file['segments']);
    }

    public function testUpdateSrt()
    {
        // Create a temporary test file
        $testFile = 'test_update.srt';
        $originalContent = "1\n00:00:00,000 --> 00:00:01,000\nOriginal\n";
        file_put_contents(TEST_RECORDINGS_DIR . '/' . $testFile, $originalContent);

        $newContent = "1\n00:00:00,000 --> 00:00:01,000\nUpdated\n";
        $result = $this->service->updateSrt($testFile, $newContent);

        $this->assertTrue($result);

        // Verify content was updated
        $savedContent = file_get_contents(TEST_RECORDINGS_DIR . '/' . $testFile);
        $this->assertEquals($newContent, $savedContent);

        // Cleanup
        unlink(TEST_RECORDINGS_DIR . '/' . $testFile);

        // Clean up backup
        $backupFiles = glob(TEST_HISTORY_DIR . '/test_update.srt.*');
        foreach ($backupFiles as $file) {
            unlink($file);
        }
    }

    public function testExtractDatetimeFromFilename()
    {
        $datetime = $this->service->extractDatetimeFromFilename('rec_20251201_130859.srt');

        $this->assertEquals('2025-12-01 13:08:59', $datetime);
    }

    public function testExtractDatetimeFromFilenameInvalid()
    {
        $datetime = $this->service->extractDatetimeFromFilename('invalid.srt');

        $this->assertNull($datetime);
    }
}
