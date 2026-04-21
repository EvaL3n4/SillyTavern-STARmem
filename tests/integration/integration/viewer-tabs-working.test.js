/** @jest-environment jsdom */
/**
 * Working tab — renders entries referenced by state.workingBuffer (string[] of ids).
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { renderTab } from '../../../src/integration/viewer/tabs/working.js';
import { CSS_PREFIX } from '../../../src/integration/constants.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

/** @type {HTMLElement} */
let parent;

/** Build a state with N working-scope entries, buffered in insert order. */
function makeStateWithBuffer(contents) {
    const state = createEmptyState();
    for (let i = 0; i < contents.length; i++) {
        const e = createEntry({
            scope: 'working',
            content: contents[i],
            subject: null,
            tags: [],
            relations: [],
            provenance: { sourceMessages: [i], extractor: 'test@v1' },
            now: new Date(`2026-04-20T10:${String(i).padStart(2, '0')}:00Z`),
        });
        state.entries[e.id] = e;
        state.workingBuffer.push(e.id);
    }
    return state;
}

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
});

afterEach(() => { document.body.innerHTML = ''; });

describe('viewer/tabs/working', () => {
    test('renders empty-state message when buffer is empty', async () => {
        await renderTab(parent, { state: createEmptyState(), chatId: 'a', subjectFilter: '' });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-empty`)?.textContent).toContain('empty');
    });

    test('renders entry count in header', async () => {
        const state = makeStateWithBuffer(['reply one', 'reply two']);
        await renderTab(parent, { state, chatId: 'a', subjectFilter: '' });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-working-header`)?.textContent).toContain('2 entries');
    });

    test('singular entry label', async () => {
        const state = makeStateWithBuffer(['only']);
        await renderTab(parent, { state, chatId: 'a', subjectFilter: '' });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-working-header`)?.textContent).toContain('1 entry');
    });

    test('renders newest first', async () => {
        const state = makeStateWithBuffer(['OLD', 'NEW']);
        await renderTab(parent, { state, chatId: 'a', subjectFilter: '' });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-working-item`);
        expect(items[0].textContent).toContain('NEW');
        expect(items[1].textContent).toContain('OLD');
    });

    test('truncates messages >200 chars with inline expand', async () => {
        const long = 'x'.repeat(500);
        const state = makeStateWithBuffer([long]);
        await renderTab(parent, { state, chatId: 'a', subjectFilter: '' });
        const contentEl = parent.querySelector(`.${CSS_PREFIX}-viewer-working-content`);
        expect(contentEl?.textContent).toContain('…');
        const expand = contentEl?.querySelector(`.${CSS_PREFIX}-viewer-expand`);
        expect(expand).not.toBeNull();
        /** @type {HTMLButtonElement} */ (expand).click();
        expect(contentEl?.textContent).toContain(long);
    });

    test('uses textContent (safe from HTML injection)', async () => {
        const state = makeStateWithBuffer(['<script>alert("XSS")</script>']);
        await renderTab(parent, { state, chatId: 'a', subjectFilter: '' });
        expect(parent.querySelector('script')).toBeNull();
        expect(parent.innerHTML).not.toContain('<script>alert');
    });

    test('handles missing state / workingBuffer gracefully', async () => {
        await renderTab(parent, { state: /** @type {any} */ ({}), chatId: 'a', subjectFilter: '' });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-empty`)).not.toBeNull();
    });

    test('skips stale buffer ids (entry missing from state.entries)', async () => {
        const state = createEmptyState();
        state.workingBuffer = ['ghost1', 'ghost2'];
        // No matching entries.
        await renderTab(parent, { state, chatId: 'a', subjectFilter: '' });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-empty`)).not.toBeNull();
    });

    test('formats timestamp as ISO with space', async () => {
        const state = makeStateWithBuffer(['hi']);
        // Override createdAt to a specific value for deterministic formatting.
        const [id] = state.workingBuffer;
        state.entries[id].lifecycle.createdAt = '2026-04-20T10:15:30.123Z';
        await renderTab(parent, { state, chatId: 'a', subjectFilter: '' });
        const meta = parent.querySelector(`.${CSS_PREFIX}-viewer-working-meta`);
        expect(meta?.textContent).toContain('2026-04-20 10:15:30Z');
    });
});
