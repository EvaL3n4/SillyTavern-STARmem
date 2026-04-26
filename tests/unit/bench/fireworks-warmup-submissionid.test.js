/**
 * Regression for finding #7: fireworks-warmup must reject submissionIds
 * that contain path separators or are absolute paths.
 */
import { describe, test, expect } from '@jest/globals';
import { parseArgv } from '../../../bench/harness/fireworks-warmup.js';

describe('parseArgv submissionId validation', () => {
    test('rejects resume with ../ traversal', () => {
        expect(() => parseArgv(['resume', '../../../../etc'])).toThrow(/invalid submission/i);
    });

    test('rejects continue with absolute path', () => {
        expect(() => parseArgv(['continue', '/tmp/evil'])).toThrow(/invalid submission/i);
    });

    test('rejects submit --submission-id with path separator', () => {
        expect(() => parseArgv([
            'submit', '--corpora', 'locomo', '--submission-id', 'foo/bar',
        ])).toThrow(/invalid submission/i);
    });

    test('accepts ordinary hex/dash submission ids', () => {
        expect(parseArgv(['resume', 'abc123-def456']).submissionId).toBe('abc123-def456');
        expect(parseArgv(['continue', 'submission_20260424']).submissionId).toBe(
            'submission_20260424',
        );
    });
});
