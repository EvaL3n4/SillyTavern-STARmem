import { describe, test, expect } from '@jest/globals';
import { renderByTaskType } from '../../../../bench/render/by-task-type.js';

describe('renderByTaskType', () => {
    test('renders empty byTaskType as informational message', () => {
        expect(renderByTaskType({})).toContain('No per-task-type slice');
        expect(renderByTaskType(null)).toContain('No per-task-type slice');
    });

    test('renders full LongMemEval 6-type table in canonical order', () => {
        const input = {
            'multi-session':              { mrr: 0.5, coverage: 0.6, n_scored: 50, n_skipped: 10 },
            'single-session-user':        { mrr: 0.9, coverage: 0.95, n_scored: 100, n_skipped: 5 },
            'single-session-assistant':   { mrr: 0.85, coverage: 0.9, n_scored: 80, n_skipped: 5 },
            'single-session-preference':  { mrr: 0.88, coverage: 0.92, n_scored: 60, n_skipped: 4 },
            'temporal-reasoning':         { mrr: 0.4, coverage: 0.5, n_scored: 40, n_skipped: 20 },
            'knowledge-update':           { mrr: 0.6, coverage: 0.7, n_scored: 30, n_skipped: 10 },
        };
        const out = renderByTaskType(input);
        const lines = out.trim().split('\n');
        // Header (2 lines) + 6 data rows
        expect(lines.length).toBe(8);
        // Canonical order: single-session-user first, multi-session last
        expect(lines[2]).toMatch(/single-session-user/);
        expect(lines[7]).toMatch(/multi-session/);
    });

    test('includes headline when provided', () => {
        const out = renderByTaskType({ 'x': { mrr: 1, coverage: 1, n_scored: 1 } }, { headline: '## My headline' });
        expect(out).toMatch(/## My headline/);
    });

    test('puts unknown task types after known ones, sorted alphabetically', () => {
        const input = {
            'custom-b': { mrr: 0.5, coverage: 0.5, n_scored: 1 },
            'single-session-user': { mrr: 0.5, coverage: 0.5, n_scored: 1 },
            'custom-a': { mrr: 0.5, coverage: 0.5, n_scored: 1 },
        };
        const out = renderByTaskType(input);
        const lines = out.trim().split('\n').slice(2);
        expect(lines[0]).toMatch(/single-session-user/);
        expect(lines[1]).toMatch(/custom-a/);
        expect(lines[2]).toMatch(/custom-b/);
    });
});
