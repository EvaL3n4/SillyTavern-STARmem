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

    test('empty corpus → no hit, empty scored', () => {
        const r = tier2(state([]), 'anything', { now, intent: 'factual' });
        expect(r.hit).toBe(false);
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

    test('hit=true when top score ≥ τ_conf AND gap ≥ τ_gap', () => {
        const widerScorer = (entry) => entry.id === 'a' ? 10.0 : 0.5;
        registerScorer('wide', widerScorer);
        setScorer('wide');

        const s = state([
            ep('a', 'alice marseille', 'alice', ['location']),
            ep('b', 'unrelated content'),
        ]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.hit).toBe(true);
        expect(r.scored[0].entry.id).toBe('a');
    });

    test('hit=false when top score below τ_confidence', () => {
        const lowScorer = () => 0.5;
        registerScorer('low', lowScorer);
        setScorer('low');
        const s = state([
            ep('a', 'alice marseille'),
            ep('b', 'bob paris'),
        ]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.hit).toBe(false);
        expect(r.scored.length).toBeGreaterThan(0);
    });

    test('hit=false when gap below τ_gap', () => {
        const flatScorer = () => 5.0;
        registerScorer('flat', flatScorer);
        setScorer('flat');
        const s = state([
            ep('a', 'alice'),
            ep('b', 'alice'),
        ]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.hit).toBe(false);
    });

    test('single-result hit: gap computed against implicit 0', () => {
        const highScorer = () => 10.0;
        registerScorer('high', highScorer);
        setScorer('high');
        const s = state([ep('a', 'alice marseille')]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        if (r.scored.length === 1) {
            expect(r.hit).toBe(true);
        } else {
            expect(r.hit).toBe(false);
        }
    });

    test('zero-scored candidates are filtered out before gap check', () => {
        const zeroForA = (entry) => entry.id === 'a' ? 0 : 3.0;
        registerScorer('zeroForA', zeroForA);
        setScorer('zeroForA');
        const s = state([
            ep('a', 'alice marseille'),
            ep('b', 'alice marseille'),
        ]);
        const r = tier2(s, 'alice marseille', { now, intent: 'factual' });
        expect(r.scored.find(s2 => s2.entry.id === 'a')).toBeUndefined();
    });

    test('working-scope entries are NOT indexed by Tier 2', () => {
        const working = ep('w', 'alice marseille');
        working.scope = 'working';
        const s = state([working, ep('a', 'alice marseille')]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.scored.every(s2 => s2.entry.id !== 'w')).toBe(true);
    });
});
