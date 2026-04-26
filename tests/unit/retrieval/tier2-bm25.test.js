import { tier2 } from '../../../src/retrieval/tier2-bm25.js';
import { _resetScorerForTests, registerScorer, setScorer } from '../../../src/retrieval/scorer.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function ep(id, content, subject = null, tags = [], overrides = {}) {
    const e = createEntry({
        scope: 'episodic', content, subject, tags,
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...e, id, ...overrides };
}

function state(entries) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    return s;
}

const now = new Date('2026-04-20T12:00:00Z');

describe('tier2', () => {
    afterEach(() => _resetScorerForTests());

    test('empty corpus → empty scored', () => {
        const r = tier2(state([]), 'anything', { now, intent: 'factual' });
        expect(r.scored).toEqual([]);
    });

    test('scored results are sorted by score descending', () => {
        const s = state([
            ep('a', 'alice lives in marseille', 'alice', ['location']),
            ep('b', 'bob lives in paris', 'bob', ['location']),
            ep('c', 'cats are cute'),
        ]);
        const r = tier2(s, 'alice marseille', { now, intent: 'factual' });
        expect(r.scored.length).toBeGreaterThan(0);
        expect(r.scored[0].entry.id).toBe('a');
        for (let i = 1; i < r.scored.length; i++) {
            expect(r.scored[i - 1].score).toBeGreaterThanOrEqual(r.scored[i].score);
        }
    });

    test('returns scored candidates for Tier 3 seeding', () => {
        const s = state([
            ep('a', 'alice marseille', 'alice', ['location']),
            ep('b', 'unrelated content'),
        ]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.scored.length).toBeGreaterThan(0);
        expect(r.scored[0].entry.id).toBe('a');
    });

    test('single-result corpus returns one scored entry', () => {
        const s = state([
            ep('a', 'alice marseille', null, [], {
                lifecycle: { importance: 100, maturity: 'core', createdAt: new Date('2026-04-20T12:00:00Z') },
            }),
        ]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.scored.length).toBe(1);
        expect(r.scored[0].entry.id).toBe('a');
    });

    test('identical scores produce zero gap but still return scored', () => {
        const s = state([
            ep('a', 'alice marseille'),
            ep('b', 'alice marseille'),
        ]);
        const r = tier2(s, 'alice marseille', { now, intent: 'factual' });
        expect(r.scored.length).toBe(2);
        expect(r.scored[0].score).toBeCloseTo(r.scored[1].score, 10);
    });

    test('working-scope entries are NOT indexed by Tier 2', () => {
        const working = ep('w', 'alice marseille');
        working.scope = 'working';
        const s = state([working, ep('a', 'alice marseille')]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.scored.every(s2 => s2.entry.id !== 'w')).toBe(true);
    });

    test('diagnostic mode exposes per-candidate factor breakdown', () => {
        const s = state([
            ep('a', 'alice marseille', 'alice', ['location'], {
                lifecycle: { importance: 50, maturity: 'validated', createdAt: new Date('2026-04-20T12:00:00Z') },
            }),
            ep('b', 'bob paris', 'bob', ['location'], {
                lifecycle: { importance: 10, maturity: 'draft', createdAt: new Date('2026-04-19T12:00:00Z') },
            }),
        ]);
        const r = tier2(s, 'alice marseille', { now, intent: 'factual', diagnostic: true });
        expect(r.scored.length).toBeGreaterThanOrEqual(1);
        const first = r.scored[0];
        expect(first.factors).toBeDefined();
        expect(typeof first.factors.bm25).toBe('number');
        expect(typeof first.factors.importance).toBe('number');
        expect(typeof first.factors.recencyFactor).toBe('number');
        expect(typeof first.factors.maturityFactor).toBe('number');
        expect(typeof first.factors.importanceFactor).toBe('number');
        expect(typeof first.score).toBe('number');
        // Score should equal the product of factors
        const expectedScore = first.factors.bm25
            * first.factors.importanceFactor
            * first.factors.recencyFactor
            * first.factors.maturityFactor;
        expect(first.score).toBeCloseTo(expectedScore, 10);
    });
});
