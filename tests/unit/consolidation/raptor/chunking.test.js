import { describe, test, expect } from '@jest/globals';
import { chunkEntries } from '../../../../src/consolidation/raptor/chunking.js';
import { createEntry } from '../../../../src/memory/entry.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

/** @param {Partial<Parameters<typeof createEntry>[0]>} over */
function ep(over) {
    return createEntry({
        scope: 'episodic',
        content: over.content ?? 'alice traveled to marseille',
        subject: 'subject' in over ? over.subject : 'alice',
        tags: over.tags ?? [],
        relations: over.relations ?? [],
        provenance: over.provenance ?? { sourceMessages: [], extractor: 'test' },
        now: over.now ?? FIXED_NOW,
    });
}

describe('chunkEntries (identity stub)', () => {
    test('empty input → empty output', () => {
        expect(chunkEntries([])).toEqual([]);
    });

    test('throws on non-array', () => {
        expect(() => chunkEntries(/** @type {any} */ ('not an array'))).toThrow(/array/);
    });

    test('1 entry → 1 leaf with stable id', () => {
        const e = ep({ content: 'alice is happy', subject: 'alice' });
        const leaves = chunkEntries([e]);
        expect(leaves).toHaveLength(1);
        expect(leaves[0].id).toBe(`leaf_${e.id}_0`);
        expect(leaves[0].sourceEntryIds).toEqual([e.id]);
        expect(leaves[0].text).toBe('alice is happy');
        expect(leaves[0].subject).toBe('alice');
    });

    test('preserves null subject', () => {
        const e = ep({ subject: null });
        const leaves = chunkEntries([e]);
        expect(leaves[0].subject).toBeNull();
    });

    test('3 entries → 3 leaves in order', () => {
        const es = [
            ep({ content: 'a' }),
            ep({ content: 'b' }),
            ep({ content: 'c' }),
        ];
        const leaves = chunkEntries(es);
        expect(leaves.map(l => l.text)).toEqual(['a', 'b', 'c']);
        expect(leaves.map(l => l.sourceEntryIds[0])).toEqual(es.map(e => e.id));
    });

    test('leaf ids are unique across distinct entries', () => {
        const es = [ep({ content: 'a' }), ep({ content: 'b' })];
        const leaves = chunkEntries(es);
        expect(new Set(leaves.map(l => l.id)).size).toBe(2);
    });
});
