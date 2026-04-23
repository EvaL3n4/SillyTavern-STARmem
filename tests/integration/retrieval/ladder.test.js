import { retrieve } from '../../../src/retrieval/ladder.js';
import { _resetScorerForTests, registerScorer, setScorer } from '../../../src/retrieval/scorer.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function ep(id, content, subject = null, tags = [], overrides = {}) {
    const base = createEntry({
        scope: 'episodic', content, subject, tags,
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...base, id, ...overrides };
}

function seed(entries, working = []) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    for (const w of working) {
        s.entries[w.id] = { ...w, scope: 'working' };
        s.workingBuffer.push(w.id);
    }
    return s;
}

const now = new Date('2026-04-20T12:00:00Z');

describe('retrieve (ladder integration)', () => {
    afterEach(() => _resetScorerForTests());

    test('fresh chat with empty state → floor returns []', () => {
        const s = createEmptyState();
        const r = retrieve(s, 'anything', { now });
        expect(r.tierResolved).toBe('floor');
        expect(r.entries).toEqual([]);
        expect(r.trace.classifier).toBe('factual');
    });

    test('floor returns top-K by lifecycle when BM25 zeros out', () => {
        const s = seed([ep('a', 'alice')]);
        const r = retrieve(s, 'zzz-not-in-corpus', { now, k: 3 });
        expect(r.tierResolved).toBe('floor');
        expect(r.entries).toHaveLength(1);
    });

    test('novel query hits Tier 3 (Tier 2 feeds seeds, never returns as resolver post-Phase 12)', () => {
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice lives in marseille', 'alice', ['location']),
            ep('b', 'bob lives in paris', 'bob', ['location']),
        ]);
        const r = retrieve(s, 'alice marseille', { now });
        expect(r.tierResolved).toBe(3);
        expect(r.entries[0].id).toBe('a');
    });

    test('identical consecutive query hits Tier 0 on second call', () => {
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice marseille', 'alice', ['location']),
            ep('b', 'bob paris', 'bob', ['location']),
        ]);
        const first = retrieve(s, 'alice marseille', { now });
        const second = retrieve(first.state, 'alice marseille', { now });
        expect(second.tierResolved).toBe(0);
        expect(second.entries[0].id).toBe('a');
    });

    test('near-duplicate query hits Tier 1 on second call', () => {
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice marseille location', 'alice', ['location']),
            ep('b', 'bob paris', 'bob', ['location']),
        ]);
        const first = retrieve(s, 'alice marseille location', { now });
        const second = retrieve(first.state, 'marseille alice location', { now });
        expect(second.tierResolved).toBe(1);
    });

    test('working-buffer entries are prepended to every result', () => {
        registerScorer('wide', () => 10.0);
        setScorer('wide');
        const w = ep('w1', 'working entry content');
        const s = seed([ep('a', 'alice marseille')], [w]);
        const r = retrieve(s, 'alice', { now });
        expect(r.entries[0].id).toBe('w1');
    });

    test('trace is emitted and appended to state.runtime.traces', () => {
        const s = seed([ep('a', 'alice marseille')]);
        const r = retrieve(s, 'alice', { now });
        expect(r.trace).toBeDefined();
        expect(r.trace.scorerId).toBe('default');
        expect(r.state.runtime.traces).toHaveLength(1);
        expect(r.state.runtime.traces[0]).toBe(r.trace);
    });

    test('applyAccessEvent fires for returned entries only', () => {
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice marseille'),
            ep('b', 'bob paris'),
            ep('c', 'cats'),
        ]);
        const r = retrieve(s, 'alice marseille', { now, k: 1 });
        const returnedIds = r.entries.map(e => e.id);
        expect(returnedIds).toHaveLength(1);
        const returnedId = returnedIds[0];
        expect(r.state.entries[returnedId].lifecycle.accessCount).toBe(1);
        const others = ['a', 'b', 'c'].filter(id => id !== returnedId);
        for (const id of others) {
            expect(r.state.entries[id].lifecycle.accessCount).toBe(0);
        }
    });

    test('Tier 3 stub: when Tier 2 has candidates, ladder resolves at Tier 3 (Phase 12 demolition invariant)', () => {
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const s = seed([
            ep('a', 'alice marseille'),
            ep('b', 'alice paris'),
        ]);
        const r = retrieve(s, 'alice', { now });
        expect(r.tierResolved).toBe(3);
        expect(r.entries.length).toBeGreaterThan(0);
    });
});

describe('retrieve — Tier 2 demolition (Phase 12 Task 1)', () => {
    afterEach(() => _resetScorerForTests());

    test('retrieve() never returns tierResolved: 2 — Tier 2 always feeds Tier 3', () => {
        // Seed a state that would previously have satisfied the Tier 2
        // tau-confidence + tau-gap shortcut (one strong BM25 hit, one weak,
        // large margin). Post-demolition, the ladder must proceed to Tier 3
        // regardless of the gap and return tierResolved: 3 (or 'floor' if
        // Tier 3 also produces nothing).
        registerScorer('sharp', (entry) => entry.id === 'a' ? 100.0 : 0.1);
        setScorer('sharp');
        const s = seed([
            ep('a', 'alice lives in marseille', 'alice', ['location']),
            ep('b', 'bob lives in paris', 'bob', ['location']),
        ]);
        const r = retrieve(s, 'alice marseille', { now });
        expect(r.tierResolved).not.toBe(2);
        expect([3, 'floor']).toContain(r.tierResolved);
    });

    test('Tier 2 BM25 candidates still flow through to Tier 3 seeds (trace.perTier["2"] retained)', () => {
        // Post-demolition, Tier 3 resolution still populates perTier['2']
        // with the BM25 candidates that seeded it. This pins the
        // "Tier 2 is the seed provider" invariant.
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const s = seed([
            ep('a', 'alice marseille'),
            ep('b', 'alice paris'),
        ]);
        const r = retrieve(s, 'alice', { now });
        expect(r.tierResolved).toBe(3);
        expect(r.trace.perTier['2']).toBeDefined();
        expect(Array.isArray(r.trace.perTier['2'])).toBe(true);
        expect(r.trace.perTier['2'].length).toBeGreaterThan(0);
    });
});

describe('retrieve — Tier 3 (real, Phase 5)', () => {
    afterEach(() => _resetScorerForTests());

    test('Tier 3 expands beyond Tier 2 seeds via graph edges', () => {
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const entries = [
            ep('a', 'Alice Marseille', 'alice', ['location']),
            ep('b', 'Alice Paris', 'alice', ['location']),
            ep('c', 'Bob Tokyo', 'bob', ['location']),
        ];
        const s = seed(entries);
        s.graph.edges.push({ from: 'a', to: 'b', type: /** @type {'mentions'} */ ('mentions'), weight: 0.5 });
        const r = retrieve(s, 'alice', { now });
        expect(r.tierResolved).toBe(3);
        const ids = r.entries.map(e => e.id);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
    });

    test("Tier 3 trace records its own perTier['3'] (not a copy of '2')", () => {
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const s = seed([
            ep('a', 'Alice Marseille'),
            ep('b', 'Alice Paris'),
        ]);
        s.graph.edges.push({ from: 'a', to: 'b', type: /** @type {'mentions'} */ ('mentions'), weight: 0.5 });
        const r = retrieve(s, 'alice', { now });
        expect(r.tierResolved).toBe(3);
        const perTier2 = r.trace.perTier['2'];
        const perTier3 = r.trace.perTier['3'];
        expect(Array.isArray(perTier2)).toBe(true);
        expect(Array.isArray(perTier3)).toBe(true);
        expect(perTier3).not.toBe(perTier2);
    });

    test('Tier 3 resolution: access events fire on Tier 3 output only, not Tier 2 seeds', () => {
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const s = seed([
            ep('a', 'Alice Marseille'),
            ep('b', 'Alice Paris'),
            ep('c', 'Carol Tokyo'),
        ]);
        s.graph.edges.push({ from: 'a', to: 'b', type: /** @type {'mentions'} */ ('mentions'), weight: 0.5 });
        const r = retrieve(s, 'alice', { now, k: 2 });
        expect(r.tierResolved).toBe(3);
        const returnedIds = r.entries.map(e => e.id);
        for (const id of returnedIds) {
            expect(r.state.entries[id].lifecycle.accessCount).toBe(1);
        }
        expect(r.state.entries['c'].lifecycle.accessCount).toBe(0);
    });
});
