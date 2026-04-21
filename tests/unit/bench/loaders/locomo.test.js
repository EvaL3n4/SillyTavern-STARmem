import { describe, test, expect, beforeAll } from '@jest/globals';
import { loadLocomo, CANONICAL_URL } from '../../../../bench/loaders/locomo.js';
import path from 'node:path';

describe('loadLocomo', () => {
    let corpus;

    beforeAll(async () => {
        corpus = await loadLocomo({ maxConversations: 2, offline: false });
    }, 30000);

    test('returns an array of conversations', () => {
        expect(Array.isArray(corpus)).toBe(true);
        expect(corpus.length).toBe(2);
    });

    test('each conversation has id, turns, qa', () => {
        for (const c of corpus) {
            expect(typeof c.id).toBe('string');
            expect(Array.isArray(c.turns)).toBe(true);
            expect(Array.isArray(c.qa)).toBe(true);
            expect(c.turns.length).toBeGreaterThan(0);
        }
    });

    test('turns are well-formed', () => {
        for (const turn of corpus[0].turns) {
            expect(typeof turn.speaker).toBe('string');
            expect(typeof turn.text).toBe('string');
            expect(typeof turn.sessionId).toBe('number');
            expect(typeof turn.turnIndex).toBe('number');
        }
    });

    test('qa items reference evidence turns that exist', () => {
        for (const qa of corpus[0].qa) {
            for (const tid of qa.evidenceTurns) {
                expect(tid).toBeGreaterThanOrEqual(0);
                expect(tid).toBeLessThan(corpus[0].turns.length);
            }
        }
    });

    test('canonical url points at snap-research', () => {
        expect(CANONICAL_URL).toContain('snap-research/locomo');
    });

    test('second call hits the cache (fast, no network)', async () => {
        const t0 = Date.now();
        const again = await loadLocomo({ maxConversations: 2, offline: true });
        expect(again.length).toBe(2);
        expect(Date.now() - t0).toBeLessThan(500);
    });

    test('offline=true fails cleanly if no cache', async () => {
        const fakeCache = path.resolve('/tmp/nonexistent-locomo-cache');
        await expect(
            loadLocomo({ cachePath: fakeCache, offline: true })
        ).rejects.toThrow(/no cached corpus/i);
    });
});
