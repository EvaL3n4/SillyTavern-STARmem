import { prependWorking } from '../../../src/retrieval/workingBuffer.js';
import { createEntry } from '../../../src/memory/entry.js';

const now = new Date('2026-04-20T12:00:00Z');

function scored(entry, score = 1.0, bm25 = 0.5) {
    return { entry, bm25, score };
}

function e(scope, content, id) {
    const out = createEntry({
        scope, content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now,
    });
    if (id) return { ...out, id };
    return out;
}

describe('prependWorking', () => {
    test('empty buffer passes through results unchanged', () => {
        const results = [scored(e('episodic', 'a')), scored(e('episodic', 'b'))];
        expect(prependWorking(results, [], now)).toEqual(results);
    });

    test('empty results yields wrapped working entries only', () => {
        const w1 = e('working', 'x');
        const w2 = e('working', 'y');
        const out = prependWorking([], [w1, w2], now);
        expect(out).toHaveLength(2);
        expect(out[0].entry.id).toBe(w1.id);
        expect(out[1].entry.id).toBe(w2.id);
        expect(out[0].score).toBe(Infinity);
    });

    test('working entries come before results', () => {
        const w = e('working', 'fresh');
        const r = e('episodic', 'old');
        const out = prependWorking([scored(r)], [w], now);
        expect(out[0].entry.id).toBe(w.id);
        expect(out[1].entry.id).toBe(r.id);
    });

    test('working entries preserve buffer insertion order', () => {
        const w1 = e('working', 'first');
        const w2 = e('working', 'second');
        const w3 = e('working', 'third');
        const out = prependWorking([], [w1, w2, w3], now);
        expect(out.map(x => x.entry.id)).toEqual([w1.id, w2.id, w3.id]);
    });

    test('dedupes results against working entries by id', () => {
        const w = e('working', 'shared');
        // Simulate the same id appearing in results (uncommon but possible).
        const results = [scored({ ...w, content: 'older copy' })];
        const out = prependWorking(results, [w], now);
        expect(out).toHaveLength(1);
        expect(out[0].entry.content).toBe('shared');  // working copy wins
    });

    test('working entries are assigned score=Infinity and bm25=0', () => {
        const w = e('working', 'x');
        const [wrapped] = prependWorking([], [w], now);
        expect(wrapped.score).toBe(Infinity);
        expect(wrapped.bm25).toBe(0);
    });

    test('rejects malformed inputs', () => {
        expect(() => prependWorking(/** @type {any} */ (null), [], now)).toThrow(/results/);
        expect(() => prependWorking([], /** @type {any} */ (null), now)).toThrow(/working/);
    });
});
