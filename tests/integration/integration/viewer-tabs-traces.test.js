/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { renderTab } from '../../../src/integration/viewer/tabs/traces.js';
import { CSS_PREFIX } from '../../../src/integration/constants.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';

let parent;

function sampleTrace({ ts, query, classifier = 'factual', tierResolved = 2, topScore = 1.5 }) {
    return {
        timestamp: ts,
        query,
        classifier,
        tierResolved,
        perTier: { [String(tierResolved)]: [{ id: 'x', bm25: topScore - 0.3, score: topScore }] },
        finalRanking: ['x'],
        injectedFragment: `[STARmem] ${query}`,
    };
}

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    // URL.createObjectURL stub for JSDOM
    if (!/** @type {any} */ (URL).createObjectURL) {
        /** @type {any} */ (URL).createObjectURL = jest.fn(() => 'blob:stub');
        /** @type {any} */ (URL).revokeObjectURL = jest.fn();
    }
    const store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
});

afterEach(() => {
    document.body.innerHTML = '';
    _resetBackendForTests();
    _resetLocksForTests();
});

describe('viewer/tabs/traces', () => {
    test('renders header + controls when traces empty', async () => {
        await renderTab(parent, { chatId: 'c', state: { runtime: { traces: [] } } });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-traces-header`)?.textContent).toContain('0 entries');
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-traces-export`)).not.toBeNull();
    });

    test('export button disabled when no traces', async () => {
        await renderTab(parent, { chatId: 'c', state: { runtime: { traces: [] } } });
        const btn = /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-traces-export`));
        expect(btn.disabled).toBe(true);
    });

    test('renders traces latest-first', async () => {
        await renderTab(parent, {
            chatId: 'c',
            state: { runtime: { traces: [
                sampleTrace({ ts: '2026-04-20T10:00:00Z', query: 'FIRST' }),
                sampleTrace({ ts: '2026-04-20T10:01:00Z', query: 'SECOND' }),
            ] } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-traces-item`);
        expect(items[0].textContent).toContain('SECOND');
        expect(items[1].textContent).toContain('FIRST');
    });

    test('summary line includes tier + classifier + top-score', async () => {
        await renderTab(parent, {
            chatId: 'c',
            state: { runtime: { traces: [
                sampleTrace({ ts: '2026-04-20T10:00:00Z', query: 'q', classifier: 'temporal', tierResolved: 3, topScore: 2.34 }),
            ] } },
        });
        const s = parent.querySelector(`.${CSS_PREFIX}-viewer-traces-summary`);
        expect(s?.textContent).toContain('T3/temporal');
        expect(s?.textContent).toContain('top=2.34');
    });

    test('details block contains raw JSON', async () => {
        const trace = sampleTrace({ ts: '2026-04-20T10:00:00Z', query: 'q' });
        await renderTab(parent, { chatId: 'c', state: { runtime: { traces: [trace] } } });
        const pre = parent.querySelector(`.${CSS_PREFIX}-viewer-traces-raw`);
        expect(pre?.textContent).toContain('"query": "q"');
    });

    test('Download JSONL button triggers blob creation', async () => {
        const createSpy = jest.spyOn(/** @type {any} */ (URL), 'createObjectURL');
        await renderTab(parent, {
            chatId: 'c',
            state: { runtime: { traces: [
                sampleTrace({ ts: '2026-04-20T10:00:00Z', query: 'q' }),
            ] } },
        });
        const btn = /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-traces-export`));
        btn.click();
        expect(createSpy).toHaveBeenCalled();
        createSpy.mockRestore();
    });

    test('JSONL filename contains ISO date without colons', async () => {
        let capturedName = null;
        const origCreate = /** @type {any} */ (document).createElement.bind(document);
        /** @type {any} */ (document).createElement = (tag) => {
            const el = origCreate(tag);
            if (tag === 'a') {
                const origSet = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'download')?.set;
                Object.defineProperty(el, 'download', {
                    set(v) { capturedName = v; origSet?.call(this, v); },
                    configurable: true,
                });
            }
            return el;
        };
        try {
            await renderTab(parent, {
                chatId: 'c',
                state: { runtime: { traces: [sampleTrace({ ts: '2026-04-20T10:00:00Z', query: 'q' })] } },
            });
            /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-traces-export`)).click();
            expect(capturedName).toMatch(/^starmem-traces-.+\.jsonl$/);
            expect(capturedName).not.toContain(':');
        } finally {
            /** @type {any} */ (document).createElement = origCreate;
        }
    });

    test('Clear button calls clearTraces and re-renders', async () => {
        const confirmSpy = jest.spyOn(globalThis, 'confirm').mockReturnValue(true);
        const store = new Map();
        store.set('c', {
            ...createEmptyState(),
            runtime: {
                traces: [sampleTrace({ ts: '2026-04-20T10:00:00Z', query: 'q' })],
                consolidating: false,
            },
        });
        setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });

        await renderTab(parent, { chatId: 'c', state: store.get('c') });
        const clearBtn = /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-traces-clear`));
        clearBtn.click();
        await new Promise(r => setTimeout(r, 20));
        const after = store.get('c');
        expect(after.runtime.traces).toEqual([]);
        confirmSpy.mockRestore();
    });

    test('Clear button no-op when user cancels confirm', async () => {
        const confirmSpy = jest.spyOn(globalThis, 'confirm').mockReturnValue(false);
        const store = new Map();
        const original = sampleTrace({ ts: '2026-04-20T10:00:00Z', query: 'q' });
        store.set('c', {
            ...createEmptyState(),
            runtime: { traces: [original], consolidating: false },
        });
        setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
        await renderTab(parent, { chatId: 'c', state: store.get('c') });
        /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-traces-clear`)).click();
        await new Promise(r => setTimeout(r, 10));
        expect(store.get('c').runtime.traces).toEqual([original]);
        confirmSpy.mockRestore();
    });
});
