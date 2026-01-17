/**
 * stream_server ユーティリティ関数のテスト
 * Phase 1: 純粋関数のテスト
 */

const {
    formatUptime,
    extractDatetimeFromFilename,
    extractDatetimeForSort,
    extractSourceInfo,
    getSrtPreview
} = require('../server');

describe('formatUptime', () => {
    test('秒のみを正しくフォーマット', () => {
        expect(formatUptime(45)).toBe('45s');
    });

    test('分と秒を正しくフォーマット', () => {
        expect(formatUptime(125)).toBe('2m 5s');
    });

    test('時間、分、秒を正しくフォーマット', () => {
        expect(formatUptime(3665)).toBe('1h 1m 5s');
    });

    test('日、時間、分を正しくフォーマット', () => {
        expect(formatUptime(90061)).toBe('1d 1h 1m');
    });

    test('0秒を正しくフォーマット', () => {
        expect(formatUptime(0)).toBe('0s');
    });

    test('24時間をちょうど1日としてフォーマット', () => {
        expect(formatUptime(86400)).toBe('1d 0h 0m');
    });
});

describe('extractDatetimeFromFilename', () => {
    test('webファイル名から日時を抽出', () => {
        const result = extractDatetimeFromFilename('web_20251229_143000_abc123.srt');
        expect(result.datetime).toBe('2025-12-29 14:30:00');
        expect(result.datetimeShort).toBe('12/29 14:30');
    });

    test('recファイル名から日時を抽出', () => {
        const result = extractDatetimeFromFilename('rec_20260117_093045.srt');
        expect(result.datetime).toBe('2026-01-17 09:30:45');
        expect(result.datetimeShort).toBe('01/17 09:30');
    });

    test('日時パターンがないファイル名はデフォルト値を返す', () => {
        const result = extractDatetimeFromFilename('invalid_filename.srt');
        expect(result.datetime).toBe('-');
        expect(result.datetimeShort).toBe('-');
    });

    test('.wavファイルでも動作', () => {
        const result = extractDatetimeFromFilename('web_20251229_143000_abc123.wav');
        expect(result.datetime).toBe('2025-12-29 14:30:00');
    });
});

describe('extractDatetimeForSort', () => {
    test('ファイル名からソート用日時を抽出', () => {
        expect(extractDatetimeForSort('web_20251229_143000_abc123.srt')).toBe('20251229_143000');
    });

    test('recファイルからソート用日時を抽出', () => {
        expect(extractDatetimeForSort('rec_20260117_093045.srt')).toBe('20260117_093045');
    });

    test('日時パターンがない場合はデフォルト値', () => {
        expect(extractDatetimeForSort('invalid.srt')).toBe('00000000_000000');
    });
});

describe('extractSourceInfo', () => {
    test('webファイルからソース情報を抽出', () => {
        const result = extractSourceInfo('web_20251229_143000_abc123.srt');
        expect(result.source).toBe('web');
        expect(result.clientId).toBe('abc123');
    });

    test('長いclientIdも正しく抽出', () => {
        const result = extractSourceInfo('web_20251229_143000_abcd1234efgh.srt');
        expect(result.source).toBe('web');
        expect(result.clientId).toBe('abcd1234efgh');
    });

    test('recファイルはanalogソース', () => {
        const result = extractSourceInfo('rec_20251229_143000.srt');
        expect(result.source).toBe('analog');
        expect(result.clientId).toBe(null);
    });

    test('不明なファイル形式はunknown', () => {
        const result = extractSourceInfo('other_20251229_143000.srt');
        expect(result.source).toBe('unknown');
        expect(result.clientId).toBe(null);
    });
});

describe('getSrtPreview', () => {
    test('SRTからテキストプレビューを抽出', () => {
        const srtContent = `1
00:00:00,000 --> 00:00:05,000
Hello world

2
00:00:05,000 --> 00:00:10,000
This is a test`;

        const preview = getSrtPreview(srtContent);
        expect(preview).toBe('Hello world This is a test');
    });

    test('空のコンテンツは空文字を返す', () => {
        expect(getSrtPreview('')).toBe('');
        expect(getSrtPreview(null)).toBe('');
        expect(getSrtPreview(undefined)).toBe('');
    });

    test('50文字以上は切り詰め', () => {
        const srtContent = `1
00:00:00,000 --> 00:00:05,000
This is a very long text that should be truncated after fifty characters definitely`;

        const preview = getSrtPreview(srtContent);
        expect(preview.length).toBeLessThanOrEqual(50);
    });

    test('シーケンス番号とタイムスタンプをスキップ', () => {
        const srtContent = `1
00:00:00,000 --> 00:00:05,000
Only this text
2
00:00:05,000 --> 00:00:10,000
And this one`;

        const preview = getSrtPreview(srtContent);
        expect(preview).not.toContain('00:00:00');
        expect(preview).not.toMatch(/^\d$/);
        expect(preview).toContain('Only this text');
    });
});
