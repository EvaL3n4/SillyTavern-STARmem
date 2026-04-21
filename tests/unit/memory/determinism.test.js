/**
 * Regression test for sub-phase 9.4.5 entry-id determinism.
 *
 * Motivated by the Phase 9.5 conv-1 smoke: identical consolidation inputs
 * produced different stateHashes (374 vs 375 facts, 9dfc08608e27 vs
 * f923d843bc7a) because randomSuffix() used Math.random(). This test
 * locks in the sha256(seed)-derived suffix so it can't regress silently.
 *
 * @see docs/plans/phase-9-4-5-id-determinism.md
 * @see docs/bench/sweeps/2026-04-21-smoke-live.md (the motivating finding)
 */
import { createEntry, generateEntryId } from '../../../src/memory/entry.js';

describe('entry id determinism', () => {
    const now = new Date('2026-04-20T14:12:33Z');

    /** @type {Parameters<typeof createEntry>[0]} */
    const baseFields = {
        scope: 'episodic',
        content: 'Alice grew up in Marseille and moved to Paris at 18.',
        subject: 'alice',
        tags: ['location', 'hometown'],
        provenance: { sourceMessages: [42, 43], extractor: 'test@v1' },
        now,
    };

    describe('createEntry — same fields, same id', () => {
        test('two entries with identical fields collapse to the same id', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({ ...baseFields });
            expect(a.id).toBe(b.id);
        });

        test('differs on content', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({ ...baseFields, content: baseFields.content + '.' });
            expect(a.id).not.toBe(b.id);
        });

        test('differs on subject', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({ ...baseFields, subject: 'bob' });
            expect(a.id).not.toBe(b.id);
        });

        test('differs on scope', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({ ...baseFields, scope: 'persona' });
            expect(a.id).not.toBe(b.id);
            expect(a.id.slice(0, 2)).toBe('ep');
            expect(b.id.slice(0, 2)).toBe('ps');
        });

        test('differs on sourceMessages', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({
                ...baseFields,
                provenance: { sourceMessages: [42, 44], extractor: 'test@v1' },
            });
            expect(a.id).not.toBe(b.id);
        });

        test('differs on extractor', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({
                ...baseFields,
                provenance: { sourceMessages: [42, 43], extractor: 'live@gemma4' },
            });
            expect(a.id).not.toBe(b.id);
        });

        test('tag insertion order does not change id', () => {
            const a = createEntry({ ...baseFields, tags: ['location', 'hometown'] });
            const b = createEntry({ ...baseFields, tags: ['hometown', 'location'] });
            expect(a.id).toBe(b.id);
        });

        test('null subject and empty-string subject yield the same id', () => {
            const a = createEntry({ ...baseFields, subject: null });
            const b = createEntry({ ...baseFields, subject: '' });
            // Subject normalization: null → '' in the seed. If this ever
            // changes, the seed spec below also changes.
            expect(a.id).toBe(b.id);
        });
    });

    describe('generateEntryId — seed contract', () => {
        test('12-hex suffix is stable across calls', () => {
            const a = generateEntryId('episodic', now, 'seed-1');
            const b = generateEntryId('episodic', now, 'seed-1');
            expect(a).toBe(b);
            expect(a.split('_').pop()).toMatch(/^[a-f0-9]{12}$/);
        });

        test('distinct seeds yield distinct suffixes', () => {
            const ids = new Set();
            for (let i = 0; i < 1000; i++) {
                ids.add(generateEntryId('episodic', now, `seed-${i}`));
            }
            expect(ids.size).toBe(1000);
        });

        test('different times with same seed yield different ids', () => {
            const t1 = new Date('2026-04-20T14:12:33Z');
            const t2 = new Date('2026-04-20T14:12:34Z');
            expect(generateEntryId('episodic', t1, 's')).not.toBe(
                generateEntryId('episodic', t2, 's'),
            );
        });
    });

    describe('batch determinism — replay produces identical id sequence', () => {
        function buildBatch() {
            const contents = [
                'Alice moved to Paris at 18.',
                'Bob started learning guitar last year.',
                'Carol ran a marathon in October.',
                'Dave adopted a cat named Miso.',
                'Eve started her PhD in linguistics.',
            ];
            return contents.map((content, i) =>
                createEntry({
                    scope: 'episodic',
                    content,
                    subject: null,
                    tags: [],
                    provenance: { sourceMessages: [i], extractor: 'test@v1' },
                    now,
                }),
            );
        }

        test('two independent batch constructions produce identical id sequences', () => {
            const a = buildBatch().map(e => e.id);
            const b = buildBatch().map(e => e.id);
            expect(a).toEqual(b);
        });

        test('every id in a batch is unique (no false collisions on distinct content)', () => {
            const ids = buildBatch().map(e => e.id);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });
});
