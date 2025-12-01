<?php
use PHPUnit\Framework\TestCase;

class SrtRepositoryTest extends TestCase
{
    private $repository;
    private $testDir;
    private $historyDir;

    protected function setUp(): void
    {
        $this->testDir = TEST_RECORDINGS_DIR;
        $this->historyDir = TEST_HISTORY_DIR;
        $this->repository = new SrtRepository($this->testDir, $this->historyDir);
    }

    protected function tearDown(): void
    {
        // Clean up history directory after each test
        $files = glob($this->historyDir . '/*');
        foreach ($files as $file) {
            if (is_file($file)) {
                unlink($file);
            }
        }
    }

    public function testListSrtFiles()
    {
        $files = $this->repository->listSrtFiles();

        $this->assertIsArray($files);
        $this->assertGreaterThanOrEqual(2, count($files));

        // Check that files are SRT files
        foreach ($files as $file) {
            $this->assertStringEndsWith('.srt', $file);
        }
    }

    public function testListSrtFilesWithLimit()
    {
        $files = $this->repository->listSrtFiles(1);

        $this->assertCount(1, $files);
    }

    public function testListSrtFilesSortedByDateDesc()
    {
        $files = $this->repository->listSrtFiles();

        // rec_20251201_110000.srt should come before rec_20251201_100000.srt
        $this->assertEquals('rec_20251201_110000.srt', $files[0]);
        $this->assertEquals('rec_20251201_100000.srt', $files[1]);
    }

    public function testGetSrtContent()
    {
        $content = $this->repository->getSrtContent('rec_20251201_100000.srt');

        $this->assertStringContainsString('テスト音声1', $content);
        $this->assertStringContainsString('00:00:00,000 --> 00:00:02,000', $content);
    }

    public function testGetSrtContentFileNotFound()
    {
        $this->expectException(Exception::class);
        $this->expectExceptionMessage('File not found');
        $this->repository->getSrtContent('nonexistent.srt');
    }

    public function testSaveSrtWithBackup()
    {
        // Create a temporary test file
        $testFile = 'test_save.srt';
        $originalContent = "1\n00:00:00,000 --> 00:00:01,000\nOriginal\n";
        file_put_contents($this->testDir . '/' . $testFile, $originalContent);

        $newContent = "1\n00:00:00,000 --> 00:00:01,000\nModified\n";
        $result = $this->repository->saveSrtWithBackup($testFile, $newContent);

        $this->assertTrue($result);

        // Check new content is saved
        $savedContent = file_get_contents($this->testDir . '/' . $testFile);
        $this->assertEquals($newContent, $savedContent);

        // Check backup was created
        $backupFiles = glob($this->historyDir . '/test_save.srt.*');
        $this->assertCount(1, $backupFiles);

        // Check backup content
        $backupContent = file_get_contents($backupFiles[0]);
        $this->assertEquals($originalContent, $backupContent);

        // Cleanup
        unlink($this->testDir . '/' . $testFile);
    }

    public function testGetWavPath()
    {
        $wavPath = $this->repository->getWavPath('rec_20251201_100000.srt');

        $this->assertEquals('rec_20251201_100000.wav', $wavPath);
    }

    public function testGetWavPathWithFullPath()
    {
        $wavPath = $this->repository->getWavPath('/some/path/rec_20251201_100000.srt');

        $this->assertEquals('rec_20251201_100000.wav', $wavPath);
    }
}
