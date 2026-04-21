/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { renderTab } from '../../../src/integration/viewer/tabs/episodic.js';
import { CSS_PREFIX } from '../../../src/integration/constants.js';
import { createEntry } from '../../../src/memory/entry.js';

let parent;
const NOW = new Date('2026-04-20T10:00:00Z');

function episodicEntry({ subject = 'alice', content = 'alice fact', importance = 50, daysAgo = 0 } = {}) {
    const now = new Date(NOW.getTime() - daysAgo * 86400_000);
    const e = createEntry({
        scope: 'episodic', subject, content,
        tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 't@v1' },
        now,
    });
    e.lifecycle.importance = importance;
    return e;
}

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
});

afterEach(() => { document.body.innerHTML = ''; });

describe('viewer/tabs/episodic', () => {
    test('renders header with count', async () => {
        const e1 = episodicEntry();
        const e2 = episodicEntry({ subject: 'bob' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [e1.id]: e1, [e2.id]: e2 } },
        });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-episodic-header`)?.textContent).toContain('2/2');
    });

    test('subject filter narrows list', async () => {
        const alice = episodicEntry({ subject: 'alice' });
        const bob = episodicEntry({ subject: 'bob' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: 'ali',
            state: { entries: { [alice.id]: alice, [bob.id]: bob } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items.length).toBe(1);
    });

    test('sort by importance descending is default', async () => {
        const high = episodicEntry({ importance: 80, content: 'HIGH' });
        const low = episodicEntry({ importance: 20, content: 'LOW' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [low.id]: low, [high.id]: high } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items[0].textContent).toContain('HIGH');
    });

    test('sort select change re-renders in new order', async () => {
        const recent = episodicEntry({ daysAgo: 0, content: 'RECENT' });
        const old = episodicEntry({ daysAgo: 30, content: 'OLD' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [recent.id]: recent, [old.id]: old } },
        });
        const sel = /** @type {HTMLSelectElement} */ (parent.querySelector(`#${CSS_PREFIX}-viewer-episodic-sort`));
        sel.value = 'recency';
        sel.dispatchEvent(new Event('change'));
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items[0].textContent).toContain('RECENT');
    });

    test('renders tags inline', async () => {
        const e = episodicEntry();
        e.tags = ['paris', 'travel'];
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [e.id]: e } },
        });
        const tags = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-tag`);
        expect(tags.length).toBe(2);
        expect(tags[0].textContent).toBe('paris');
    });

    test('displays score summary in meta row', async () => {
        const e = episodicEntry({ importance: 67 });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [e.id]: e } },
        });
        const scores = parent.querySelector(`.${CSS_PREFIX}-viewer-scores`);
        expect(scores?.textContent).toContain('I=67');
    });

    test('content rendered with textContent (XSS-safe)', async () => {
        const e = episodicEntry({ content: '<script>alert(1)</script>' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [e.id]: e } },
        });
        expect(parent.querySelector('script')).toBeNull();
    });

    test('ignores non-episodic entries', async () => {
        const epi = episodicEntry();
        const persona = createEntry({
            scope: 'persona', subject: 'alice', content: 'persona',
            tags: [], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now: NOW,
        });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [epi.id]: epi, [persona.id]: persona } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items.length).toBe(1);
    });

    test('empty-state when no episodic entries', async () => {
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: {} },
        });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-episodic-header`)?.textContent).toContain('0/0');
        expect(parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`).length).toBe(0);
    });

    test('respects MAX_RENDER cap', async () => {
        const entries = {};
        for (let i = 0; i < 600; i++) {
            const e = episodicEntry({ content: `fact ${i}` });
            entries[e.id] = e;
        }
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items.length).toBe(500);
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-episodic-header`)?.textContent).toContain('showing first 500');
    });
});
