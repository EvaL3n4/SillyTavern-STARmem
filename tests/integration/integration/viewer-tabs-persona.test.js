/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock rebuildPersona at the module level — MUST come before dynamic import of the SUT.
jest.unstable_mockModule('../../../src/consolidation/index.js', () => ({
    rebuildPersona: jest.fn(),
}));

// Dynamic-import after the mock is registered so renderTab sees the mocked rebuildPersona.
const { renderTab } = await import('../../../src/integration/viewer/tabs/persona.js');
const { rebuildPersona } = await import('../../../src/consolidation/index.js');

import { CSS_PREFIX, SETTINGS_KEY, SETTINGS_DEFAULTS } from '../../../src/integration/constants.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setContextForTests as _setSettingsCtx,
    _resetContextForTests as _resetSettingsCtx,
} from '../../../src/integration/settings.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';

let parent;
let ctx;
const NOW = new Date('2026-04-20T10:00:00Z');

function personaEntry({ subject, content }) {
    return createEntry({
        scope: 'persona', subject, content,
        tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 'gemma@persona-rebuild-v1' },
        now: NOW,
    });
}

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    ctx = {
        extensionSettings: { [SETTINGS_KEY]: { ...SETTINGS_DEFAULTS, profileId: 'p1', extractionModelLabel: 'gemma@persona-rebuild-v1' } },
        saveSettingsDebounced: jest.fn(),
    };
    _setSettingsCtx(ctx);
    const store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    /** @type {any} */ (rebuildPersona).mockReset();
});

afterEach(() => {
    _resetSettingsCtx();
    _resetBackendForTests();
    _resetLocksForTests();
    document.body.innerHTML = '';
});

describe('viewer/tabs/persona', () => {
    test('groups entries by subject', async () => {
        const a1 = personaEntry({ subject: 'alice', content: 'alice is curious' });
        const a2 = personaEntry({ subject: 'alice', content: 'alice enjoys coffee' });
        const b = personaEntry({ subject: 'bob', content: 'bob plays chess' });
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: '',
            state: { entries: { [a1.id]: a1, [a2.id]: a2, [b.id]: b } },
        });
        const groups = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-persona-group`);
        expect(groups.length).toBe(2);
    });

    test('subject filter narrows to one group', async () => {
        const a = personaEntry({ subject: 'alice', content: 'a' });
        const b = personaEntry({ subject: 'bob', content: 'b' });
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: 'alice',
            state: { entries: { [a.id]: a, [b.id]: b } },
        });
        const groups = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-persona-group`);
        expect(groups.length).toBe(1);
    });

    test('empty state shows rebuild form', async () => {
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: '',
            state: { entries: {} },
        });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-persona-rebuild-form`)).not.toBeNull();
    });

    test('Rebuild button is disabled when no profileId configured', async () => {
        ctx.extensionSettings[SETTINGS_KEY].profileId = '';
        const a = personaEntry({ subject: 'alice', content: 'a' });
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: '',
            state: { entries: { [a.id]: a } },
        });
        const btn = /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-persona-rebuild`));
        expect(btn.disabled).toBe(true);
        expect(btn.title).toContain('Configure extractor LLM');
    });

    test('Rebuild click invokes rebuildPersona with subject and AbortSignal', async () => {
        /** @type {any} */ (rebuildPersona).mockResolvedValue({
            episodicCount: 10, layers: 2, replacedCount: 0, newCount: 2, duration: 500,
        });
        const a = personaEntry({ subject: 'alice', content: 'a' });
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: '',
            state: { entries: { [a.id]: a } },
        });
        const btn = /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-persona-rebuild`));
        btn.click();
        await new Promise(r => setTimeout(r, 10));
        expect(rebuildPersona).toHaveBeenCalledWith('chat-A', 'alice', expect.objectContaining({
            profileId: 'p1',
            extractorLabel: 'gemma@persona-rebuild-v1',
            signal: expect.any(AbortSignal),
            onProgress: expect.any(Function),
        }));
    });

    test('progress callback appends lines to progress box', async () => {
        /** @type {any} */ (rebuildPersona).mockImplementation(async (_c, _s, opts) => {
            opts.onProgress({ stage: 'snapshot' });
            opts.onProgress({ stage: 'cluster', depth: 1, clusters: 3 });
            return { episodicCount: 10, layers: 2, replacedCount: 0, newCount: 2, duration: 500 };
        });
        const a = personaEntry({ subject: 'alice', content: 'a' });
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: '',
            state: { entries: { [a.id]: a } },
        });
        const btn = /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-persona-rebuild`));
        btn.click();
        await new Promise(r => setTimeout(r, 20));
        const lines = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-progress-line`);
        expect([...lines].some(l => l.textContent?.includes('snapshot'))).toBe(true);
        expect([...lines].some(l => l.textContent?.includes('cluster'))).toBe(true);
        expect([...lines].some(l => l.textContent?.includes('clusters=3'))).toBe(true);
    });

    test('cancel during rebuild aborts via AbortSignal', async () => {
        /** @type {any} */ (rebuildPersona).mockImplementation(async (_c, _s, opts) => {
            await new Promise((res, rej) => {
                opts.signal.addEventListener('abort', () => {
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    rej(err);
                });
            });
            return { episodicCount: 0, layers: 0, replacedCount: 0, newCount: 0, duration: 0 };
        });
        const a = personaEntry({ subject: 'alice', content: 'a' });
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: '',
            state: { entries: { [a.id]: a } },
        });
        const btn = /** @type {HTMLButtonElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-persona-rebuild`));
        btn.click();
        await new Promise(r => setTimeout(r, 5));
        expect(btn.textContent).toBe('Cancel');
        btn.click();  // cancel
        await new Promise(r => setTimeout(r, 10));
        const lines = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-progress-line`);
        expect([...lines].some(l => l.textContent?.includes('Cancelled'))).toBe(true);
    });

    test('during rebuild, other subjects\' Rebuild buttons are disabled', async () => {
        let resolveRun;
        /** @type {any} */ (rebuildPersona).mockImplementation(() =>
            new Promise(res => { resolveRun = res; })
        );
        const a = personaEntry({ subject: 'alice', content: 'a' });
        const b = personaEntry({ subject: 'bob', content: 'b' });
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: '',
            state: { entries: { [a.id]: a, [b.id]: b } },
        });
        const buttons = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-persona-rebuild`);
        /** @type {HTMLButtonElement} */ (buttons[0]).click();
        await new Promise(r => setTimeout(r, 5));
        expect(/** @type {HTMLButtonElement} */ (buttons[1]).disabled).toBe(true);
        /** @type {any} */ (resolveRun)({ episodicCount: 0, layers: 0, replacedCount: 0, newCount: 0, duration: 0 });
    });

    test('content rendered with textContent (XSS-safe)', async () => {
        const e = personaEntry({ subject: 'alice', content: '<script>alert(1)</script>' });
        await renderTab(parent, {
            chatId: 'chat-A', subjectFilter: '',
            state: { entries: { [e.id]: e } },
        });
        expect(parent.querySelector('script')).toBeNull();
    });
});
