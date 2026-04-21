/** @jest-environment jsdom */
/**
 * Indicator — DOM mount, polling, idle/busy toggle, anchor fallback.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    mountIndicator, unmountIndicator, _tickForTests,
} from '../../../src/integration/indicator.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { CSS_PREFIX } from '../../../src/integration/constants.js';

/** @type {Map<string, any>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
});

afterEach(() => {
    unmountIndicator();
    _resetBackendForTests();
    document.body.innerHTML = '';
});

describe('indicator — mount / unmount', () => {
    test('mountIndicator creates a dot inside #send_but_container when present', () => {
        const anchor = document.createElement('div');
        anchor.id = 'send_but_container';
        document.body.appendChild(anchor);

        mountIndicator(() => 'chat-A');

        const dot = document.getElementById(`${CSS_PREFIX}-indicator`);
        expect(dot).not.toBeNull();
        expect(dot?.parentElement?.id).toBe('send_but_container');
        expect(dot?.classList.contains(`${CSS_PREFIX}-indicator`)).toBe(true);
        expect(dot?.classList.contains(`${CSS_PREFIX}-indicator-floating`)).toBe(false);
    });

    test('mountIndicator falls back to document.body with floating class when anchor absent', () => {
        mountIndicator(() => 'chat-A');

        const dot = document.getElementById(`${CSS_PREFIX}-indicator`);
        expect(dot).not.toBeNull();
        expect(dot?.parentElement).toBe(document.body);
        expect(dot?.classList.contains(`${CSS_PREFIX}-indicator-floating`)).toBe(true);
    });

    test('indicator starts in idle class', () => {
        mountIndicator(() => 'chat-A');
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(true);
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-busy`)).toBe(false);
    });

    test('double mount does not leak DOM — only one indicator present', () => {
        mountIndicator(() => 'chat-A');
        mountIndicator(() => 'chat-A');
        const all = document.querySelectorAll(`.${CSS_PREFIX}-indicator`);
        expect(all.length).toBe(1);
    });

    test('unmount removes the dot', () => {
        mountIndicator(() => 'chat-A');
        unmountIndicator();
        expect(document.getElementById(`${CSS_PREFIX}-indicator`)).toBeNull();
    });

    test('unmount is idempotent (safe to call twice)', () => {
        mountIndicator(() => 'chat-A');
        unmountIndicator();
        expect(() => unmountIndicator()).not.toThrow();
    });

    test('has ARIA role=status for screen readers', () => {
        mountIndicator(() => 'chat-A');
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.getAttribute('role')).toBe('status');
        expect(dot.getAttribute('aria-label')).toContain('STARmem');
    });
});

describe('indicator — polling behavior', () => {
    test('tick with consolidating=false keeps idle class', async () => {
        store.set('chat-A', {
            ...createEmptyState(),
            runtime: { consolidating: false, lastConsolidation: null, traces: [] },
        });
        mountIndicator(() => 'chat-A');
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(true);
    });

    test('tick with consolidating=true swaps to busy class', async () => {
        store.set('chat-A', {
            ...createEmptyState(),
            runtime: { consolidating: true, lastConsolidation: null, traces: [] },
        });
        mountIndicator(() => 'chat-A');
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-busy`)).toBe(true);
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(false);
    });

    test('title reflects lastConsolidation timestamp when busy', async () => {
        store.set('chat-A', {
            ...createEmptyState(),
            runtime: {
                consolidating: true,
                lastConsolidation: '2026-04-21T10:15:30.000Z',
                pendingPersonaRebuild: false,
                episodicCountSinceLastRebuild: 0,
                traces: [],
            },
        });
        mountIndicator(() => 'chat-A');
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.title).toContain('consolidating');
        expect(dot.title).toContain('2026-04-21T10:15:30.000Z');
    });

    test('busy → idle transition on subsequent tick', async () => {
        store.set('chat-A', {
            ...createEmptyState(),
            runtime: { consolidating: true, lastConsolidation: null, traces: [] },
        });
        mountIndicator(() => 'chat-A');
        await _tickForTests();

        // Flip the flag.
        store.set('chat-A', {
            ...createEmptyState(),
            runtime: { consolidating: false, lastConsolidation: null, traces: [] },
        });
        await _tickForTests();

        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(true);
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-busy`)).toBe(false);
    });
});

describe('indicator — defensive', () => {
    test('chatIdResolver returning null → sets idle', async () => {
        store.set('chat-A', {
            ...createEmptyState(),
            runtime: { consolidating: true, lastConsolidation: null, traces: [] },
        });
        // Resolver claims no active chat → must not query loadState + must stay idle.
        mountIndicator(() => null);
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(true);
    });

    test('backend throwing on read → tick sets idle and does not throw', async () => {
        setBackend({ read: () => { throw new Error('BOOM'); }, write: () => {} });
        mountIndicator(() => 'chat-A');
        await expect(_tickForTests()).resolves.toBeUndefined();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(true);
    });

    test('_tickForTests before mount is a no-op', async () => {
        await expect(_tickForTests()).resolves.toBeUndefined();
    });
});
