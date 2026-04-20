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

    test('novel query hits Tier 2 or Tier 3 (depending on exit condition)', () => {
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice lives in marseille', 'alice', ['location']),
            ep('b', 'bob lives in paris', 'bob', ['location']),
        ]);
        const r = retrieve(s, 'alice marseille', { now });
        expect([2, 3]).toContain(r.tierResolved);
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

    test('Tier 3 stub: when Tier 2 misses exit condition but has results, ladder resolves at Tier 3', () => {
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
