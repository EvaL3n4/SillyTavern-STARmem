import { buildIndex, query, tokenize } from '../../../src/retrieval/bm25.js';
import { createEntry } from '../../../src/memory/entry.js';

/** @type {(scope: import('../../../src/core/schema.js').Scope, content: string, subject?: string|null, tags?: string[]) => import('../../../src/core/schema.js').Entry} */
function entry(scope, content, subject = null, tags = []) {
    return createEntry({
        scope, content, subject, tags,
        provenance: { sourceMessages: [], extractor: 'test' },
    });
}

describe('tokenize', () => {
    test('lowercases and splits on non-alphanumeric', () => {
        expect(tokenize('Alice, meet Bob!')).toEqual(['alice', 'meet', 'bob']);
    });

    test('drops tokens shorter than 2 chars', () => {
        expect(tokenize('a I go')).toEqual(['go']);
    });

    test('handles unicode word chars', () => {
        const tokens = tokenize('café 123 test');
        expect(tokens).toContain('test');
        expect(tokens).toContain('123');
    });

    test('empty input returns []', () => {
        expect(tokenize('')).toEqual([]);
        expect(tokenize('!!!')).toEqual([]);
    });
});

describe('buildIndex', () => {
    test('empty corpus produces a valid empty index', () => {
        const idx = buildIndex([]);
        expect(idx.totalDocs).toBe(0);
        expect(idx.avgLen).toBe(0);
        expect(query(idx, 'anything')).toEqual([]);
    });

    test('single entry: query matches its content', () => {
        const e = entry('episodic', 'Alice grew up in Marseille');
        const idx = buildIndex([e]);
        const results = query(idx, 'Marseille');
        expect(results).toHaveLength(1);
        expect(results[0].entry.id).toBe(e.id);
        expect(results[0].bm25).toBeGreaterThan(0);
    });

    test('query with no matches returns empty', () => {
        const idx = buildIndex([entry('episodic', 'the quick brown fox')]);
        expect(query(idx, 'platypus')).toEqual([]);
    });
});

describe('query ranking (golden cases)', () => {
    const corpus = [
        entry('episodic', 'Alice grew up in Marseille, France', 'alice', ['location', 'hometown']),
        entry('episodic', 'Bob lives in Paris and works as a sculptor', 'bob', ['location', 'profession']),
        entry('episodic', 'Alice and Bob met at a café in 2015', null, ['meeting']),
        entry('episodic', 'The cat sat on the mat', null, []),
        entry('episodic', 'Alice plays violin every Sunday', 'alice', ['hobby']),
    ];
    const idx = buildIndex(corpus);

    test('"Marseille" returns the Marseille entry first', () => {
        const r = query(idx, 'Marseille');
        expect(r[0].entry.content).toMatch(/Marseille/);
    });

    test('"Alice hobby" ranks Alice+violin entry above Alice+Marseille', () => {
        const r = query(idx, 'Alice hobby');
        expect(r[0].entry.content).toMatch(/violin/);
    });

    test('subject boost: "alice" ranks alice-subject entries above content-only mentions', () => {
        const r = query(idx, 'alice');
        const top = r[0].entry;
        expect(top.subject).toBe('alice');
    });

    test('tag boost: "hometown" surfaces the Marseille entry', () => {
        const r = query(idx, 'hometown');
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].entry.content).toMatch(/Marseille/);
    });

    test('k parameter caps result count', () => {
        const r = query(idx, 'alice', 2);
        expect(r.length).toBeLessThanOrEqual(2);
    });

    test('results are sorted by bm25 descending', () => {
        const r = query(idx, 'alice');
        for (let i = 1; i < r.length; i++) {
            expect(r[i - 1].bm25).toBeGreaterThanOrEqual(r[i].bm25);
        }
    });
});

describe('empty-query handling', () => {
    test('empty string returns []', () => {
        const idx = buildIndex([entry('episodic', 'hello')]);
        expect(query(idx, '')).toEqual([]);
    });

    test('query with only stopword-length tokens returns []', () => {
        const idx = buildIndex([entry('episodic', 'hello world')]);
        expect(query(idx, 'a i')).toEqual([]);
    });
});
