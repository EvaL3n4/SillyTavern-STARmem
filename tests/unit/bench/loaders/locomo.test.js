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

    test('9.4.6: evidenceTurns is non-empty for >95% of QAs (D<day>:<turn> fix)', () => {
        // Pre-9.4.6: parseEvidence regex matched S<session>:T<index> but
        // actual LoCoMo v10 uses D<day>:<turn>. evidenceTurns was empty on
        // all 1986 QAs, which made the bench unscorable under the 9.4.6
        // evidence-turn matcher. This test locks the fix.
        let total = 0;
        let withEv = 0;
        for (const c of corpus) {
            for (const qa of c.qa) {
                total++;
                if (qa.evidenceTurns.length > 0) withEv++;
            }
        }
        expect(total).toBeGreaterThan(0);
        expect(withEv / total).toBeGreaterThan(0.95);
    });

    test('9.4.6: evidenceTurns are integer indices into turns[] (no vacuous empty lists)', () => {
        // Stronger than the original "evidence turns exist" test, which
        // was vacuously true when evidenceTurns was []. Assert at least
        // one QA has non-empty evidenceTurns, and every index is in bounds.
        const allQa = corpus.flatMap(c => c.qa.map(q => ({ conv: c, qa: q })));
        const withEv = allQa.filter(({ qa }) => qa.evidenceTurns.length > 0);
        expect(withEv.length).toBeGreaterThan(0);
        for (const { conv, qa } of withEv) {
            for (const ev of qa.evidenceTurns) {
                expect(Number.isInteger(ev)).toBe(true);
                expect(ev).toBeGreaterThanOrEqual(0);
                expect(ev).toBeLessThan(conv.turns.length);
            }
        }
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
