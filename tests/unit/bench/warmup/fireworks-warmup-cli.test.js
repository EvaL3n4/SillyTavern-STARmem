import { parseArgv, nextState, normalizeJobState } from '../../../../bench/harness/fireworks-warmup.js';

describe('fireworks-warmup CLI', () => {
    describe('parseArgv', () => {
        test('submit with defaults', () => {
            const parsed = parseArgv(['submit', '--corpora', 'locomo']);
            expect(parsed.command).toBe('submit');
            expect(parsed.corpora).toEqual(['locomo']);
            expect(parsed.model).toBe('accounts/fireworks/models/llama-v3p3-70b-instruct');
            expect(parsed.submissionId).toBeFalsy(); // auto-generated if falsy
        });

        test('submit with multi-corpus + model override', () => {
            const parsed = parseArgv(['submit', '--corpora', 'locomo,longmemeval-s', '--model', 'accounts/fireworks/models/foo']);
            expect(parsed.corpora).toEqual(['locomo', 'longmemeval-s']);
            expect(parsed.model).toBe('accounts/fireworks/models/foo');
        });

        test('submit with explicit --submission-id', () => {
            const parsed = parseArgv(['submit', '--corpora', 'locomo', '--submission-id', 'my-id']);
            expect(parsed.submissionId).toBe('my-id');
        });

        test('resume takes submissionId positional arg', () => {
            const parsed = parseArgv(['resume', 'starmem-20260423-abc']);
            expect(parsed.command).toBe('resume');
            expect(parsed.submissionId).toBe('starmem-20260423-abc');
        });

        test('continue takes submissionId positional arg', () => {
            const parsed = parseArgv(['continue', 'starmem-20260423-abc']);
            expect(parsed.command).toBe('continue');
            expect(parsed.submissionId).toBe('starmem-20260423-abc');
        });

        test('rejects unknown command', () => {
            expect(() => parseArgv(['delete', 'x'])).toThrow(/unknown command/i);
        });

        test('handles trailing comma in --corpora (empty parts filtered)', () => {
            const parsed = parseArgv(['submit', '--corpora', 'locomo,']);
            expect(parsed.corpora).toEqual(['locomo']);
        });

        test('rejects missing value after --model', () => {
            expect(() => parseArgv(['submit', '--corpora', 'locomo', '--model'])).toThrow();
        });

        test('rejects missing value after --submission-id', () => {
            expect(() => parseArgv(['submit', '--corpora', 'locomo', '--submission-id'])).toThrow();
        });

        test('submit requires --corpora', () => {
            expect(() => parseArgv(['submit'])).toThrow(/corpora/i);
        });

        test('resume and continue require submission id positional', () => {
            expect(() => parseArgv(['resume'])).toThrow(/submission.id/i);
            expect(() => parseArgv(['continue'])).toThrow(/submission.id/i);
        });
    });

    describe('nextState', () => {
        test('enumerated → uploaded', () => expect(nextState('enumerated')).toBe('uploaded'));
        test('uploaded → submitted', () => expect(nextState('uploaded')).toBe('submitted'));
        test('submitted → polling', () => expect(nextState('submitted')).toBe('polling'));
        test('polling + COMPLETED → completed', () => expect(nextState('polling', { jobState: 'COMPLETED' })).toBe('completed'));
        test('polling + RUNNING stays polling', () => expect(nextState('polling', { jobState: 'RUNNING' })).toBe('polling'));
        test('polling + PENDING stays polling', () => expect(nextState('polling', { jobState: 'PENDING' })).toBe('polling'));
        test('polling + VALIDATING stays polling', () => expect(nextState('polling', { jobState: 'VALIDATING' })).toBe('polling'));
        test('polling + EXPIRED → expired', () => expect(nextState('polling', { jobState: 'EXPIRED' })).toBe('expired'));
        test('polling + FAILED → failed', () => expect(nextState('polling', { jobState: 'FAILED' })).toBe('failed'));
        test('completed → ingested', () => expect(nextState('completed')).toBe('ingested'));
        test('throws on terminal states', () => {
            expect(() => nextState('ingested')).toThrow();
            expect(() => nextState('failed')).toThrow();
        });
        test('throws on unknown state', () => {
            expect(() => nextState('bogus')).toThrow();
        });
    });

    describe('normalizeJobState', () => {
        test('strips JOB_STATE_ prefix when present', () => {
            expect(normalizeJobState('JOB_STATE_COMPLETED')).toBe('COMPLETED');
            expect(normalizeJobState('JOB_STATE_RUNNING')).toBe('RUNNING');
            expect(normalizeJobState('JOB_STATE_EXPIRED')).toBe('EXPIRED');
            expect(normalizeJobState('JOB_STATE_FAILED')).toBe('FAILED');
            expect(normalizeJobState('JOB_STATE_PENDING')).toBe('PENDING');
            expect(normalizeJobState('JOB_STATE_VALIDATING')).toBe('VALIDATING');
        });

        test('passes bare state through unchanged', () => {
            expect(normalizeJobState('COMPLETED')).toBe('COMPLETED');
            expect(normalizeJobState('RUNNING')).toBe('RUNNING');
        });

        test('returns UNKNOWN for missing / empty / non-string input', () => {
            expect(normalizeJobState(undefined)).toBe('UNKNOWN');
            expect(normalizeJobState(null)).toBe('UNKNOWN');
            expect(normalizeJobState('')).toBe('UNKNOWN');
            expect(normalizeJobState(42)).toBe('UNKNOWN');
        });
    });
});
