/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { renderTab } from '../../../src/integration/viewer/tabs/graph.js';
import { CSS_PREFIX } from '../../../src/integration/constants.js';
import { createEntry } from '../../../src/memory/entry.js';

let parent;
const NOW = new Date('2026-04-20T10:00:00Z');

function entryFor(subject, content) {
    return createEntry({
        scope: 'episodic', subject, content,
        tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 't@v1' },
        now: NOW,
    });
}

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
});

afterEach(() => { document.body.innerHTML = ''; });

describe('viewer/tabs/graph', () => {
    test('renders header with node + edge count', async () => {
        const e1 = entryFor('alice', 'a1');
        const e2 = entryFor('bob', 'b1');
        await renderTab(parent, {
            subjectFilter: '',
            state: {
                entries: { [e1.id]: e1, [e2.id]: e2 },
                graph: { edges: [{ from: e1.id, to: e2.id, type: 'mentions', weight: 1.0 }] },
            },
        });
        const h = parent.querySelector(`.${CSS_PREFIX}-viewer-graph-header`);
        expect(h?.textContent).toContain('2 nodes');
        expect(h?.textContent).toContain('1 edges');
    });

    test('empty state when no nodes', async () => {
        await renderTab(parent, {
            subjectFilter: '',
            state: { entries: {}, graph: { edges: [] } },
        });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-empty`)).not.toBeNull();
    });

    test('ranks nodes by degree descending', async () => {
        const hub = entryFor('hub', 'central');
        const leaf1 = entryFor('leaf1', 'out1');
        const leaf2 = entryFor('leaf2', 'out2');
        await renderTab(parent, {
            subjectFilter: '',
            state: {
                entries: { [hub.id]: hub, [leaf1.id]: leaf1, [leaf2.id]: leaf2 },
                graph: { edges: [
                    { from: hub.id, to: leaf1.id, type: 'mentions', weight: 1.0 },
                    { from: hub.id, to: leaf2.id, type: 'mentions', weight: 1.0 },
                ] },
            },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-graph-item`);
        expect(items[0].getAttribute('data-id')).toBe(hub.id);
    });

    test('subject filter narrows list', async () => {
        const a = entryFor('alice', 'a');
        const b = entryFor('bob', 'b');
        await renderTab(parent, {
            subjectFilter: 'alice',
            state: { entries: { [a.id]: a, [b.id]: b }, graph: { edges: [] } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-graph-item`);
        expect(items.length).toBe(1);
    });

    test('caps neighbors per entry to MAX_NEIGHBORS_PER_ENTRY', async () => {
        const hub = entryFor('hub', 'central');
        const entries = { [hub.id]: hub };
        const edges = [];
        for (let i = 0; i < 15; i++) {
            const leaf = entryFor(`leaf${i}`, `out${i}`);
            entries[leaf.id] = leaf;
            edges.push({ from: hub.id, to: leaf.id, type: 'mentions', weight: 1.0 });
        }
        await renderTab(parent, { subjectFilter: '', state: { entries, graph: { edges } } });
        const hubItem = parent.querySelector(`[data-id="${hub.id}"]`);
        const neighbors = hubItem?.querySelectorAll(`.${CSS_PREFIX}-viewer-graph-neighbor`);
        expect(neighbors?.length).toBe(10);
        const more = hubItem?.querySelector(`.${CSS_PREFIX}-viewer-graph-neighbor-more`);
        expect(more?.textContent).toContain('+5 more');
    });

    test('XSS-safe for entry content', async () => {
        const e = entryFor('alice', '<script>alert(1)</script>');
        await renderTab(parent, {
            subjectFilter: '',
            state: { entries: { [e.id]: e }, graph: { edges: [] } },
        });
        expect(parent.querySelector('script')).toBeNull();
    });

    test('shows "+more nodes hidden" when > MAX_ENTRIES', async () => {
        const entries = {};
        for (let i = 0; i < 250; i++) {
            // Bump the timestamp per-iteration so id generation doesn't collide
            // on the 3-char random suffix within a fixed second.
            const when = new Date(NOW.getTime() + i * 1000);
            const e = createEntry({
                scope: 'episodic', subject: `subj${i}`, content: `content${i}`,
                tags: [], relations: [],
                provenance: { sourceMessages: [0], extractor: 't@v1' },
                now: when,
            });
            entries[e.id] = e;
        }
        await renderTab(parent, { subjectFilter: '', state: { entries, graph: { edges: [] } } });
        const note = parent.querySelector(`.${CSS_PREFIX}-viewer-note`);
        expect(note?.textContent).toContain('50 more nodes hidden');
    });
});
