/** @jest-environment jsdom */
/**
 * Interceptor — injection-mode behaviour (automatic / macro / off) and
 * configurable position/depth/role.
 *
 * Separate from the other interceptor.test.js suites because it sets up
 * the settings module's context (so settings.injectionMode etc. resolve)
 * in addition to the interceptor's context.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    starmemInterceptor,
    _setContextForTests as _setInterceptorCtx,
    _resetContextForTests as _resetInterceptorCtx,
} from '../../../src/integration/interceptor.js';
import {
    _setContextForTests as _setSettingsCtx,
    _resetContextForTests as _resetSettingsCtx,
    setSettings,
} from '../../../src/integration/settings.js';
import {
    INJECTION_PROMPT_KEY,
    INJECTION_MODE_AUTOMATIC, INJECTION_MODE_MACRO, INJECTION_MODE_OFF,
    INJECTION_POSITION_IN_CHAT, INJECTION_POSITION_IN_PROMPT,
    INJECTION_ROLE_SYSTEM, INJECTION_ROLE_USER,
} from '../../../src/integration/constants.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    getMemoryBody, _clearMemoryBodiesForTests,
} from '../../../src/integration/macro.js';

/** @type {Map<string, unknown>} */
let store;
/** @type {jest.Mock} */
let setExtensionPrompt;
/** @type {{ extensionSettings: Record<string, any>, saveSettingsDebounced: jest.Mock }} */
let settingsCtx;

function makeChat(userText = 'tell me about paris') {
    return [
        { name: 'char', is_user: false, is_system: false, send_date: 'd1', mes: 'hi' },
        { name: 'user', is_user: true, is_system: false, send_date: 'd2', mes: userText },
    ];
}

function seedEntry() {
    const now = new Date('2026-04-20T10:00:00Z');
    const entry = createEntry({
        scope: 'episodic', content: 'alice traveled to paris', subject: 'alice',
        tags: ['paris', 'travel'], relations: [],
        provenance: { sourceMessages: [0], extractor: 't@v1' },
        now,
    });
    store.set('chat-A', { ...createEmptyState(), entries: { [entry.id]: entry } });
    return entry;
}

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    _clearMemoryBodiesForTests();
    setExtensionPrompt = jest.fn();
    _setInterceptorCtx({ chatId: 'chat-A', setExtensionPrompt });
    settingsCtx = {
        extensionSettings: {},
        saveSettingsDebounced: jest.fn(),
    };
    _setSettingsCtx(settingsCtx);
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetInterceptorCtx();
    _resetSettingsCtx();
});

describe('interceptor — automatic mode (default)', () => {
    test('legacy defaults: IN_CHAT, depth 4, SYSTEM role', async () => {
        seedEntry();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        const [key, value, position, depth, scan, role] = setExtensionPrompt.mock.calls[0];
        expect(key).toBe(INJECTION_PROMPT_KEY);
        expect(value).toContain('alice traveled to paris');
        expect(position).toBe(INJECTION_POSITION_IN_CHAT);
        expect(depth).toBe(4);
        expect(scan).toBe(false);
        expect(role).toBe(INJECTION_ROLE_SYSTEM);
    });

    test('honours custom position / depth / role from settings', async () => {
        setSettings({
            injectionMode: INJECTION_MODE_AUTOMATIC,
            injectionPosition: INJECTION_POSITION_IN_PROMPT,
            injectionDepth: 7,
            injectionRole: INJECTION_ROLE_USER,
        });
        seedEntry();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        const [, , position, depth, , role] = setExtensionPrompt.mock.calls[0];
        expect(position).toBe(INJECTION_POSITION_IN_PROMPT);
        expect(depth).toBe(7);
        expect(role).toBe(INJECTION_ROLE_USER);
    });

    test('also caches body under chatId for macro readers', async () => {
        seedEntry();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        // Even in automatic mode, cache is populated—flipping to macro
        // mode mid-session shouldn't blank the user's preset. Cached form is
        // headerless and untagged (the macro is meant to be wrapped by user
        // prompt copy and the model doesn't need scope tags).
        const cached = getMemoryBody('chat-A');
        expect(cached).toContain('alice traveled to paris');
        expect(cached).not.toContain('Retrieved memories');
        expect(cached).not.toMatch(/\[(episodic|working|persona)\]/);
    });

    test('injected body keeps the "Retrieved memories:" header', async () => {
        seedEntry();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        const [, value] = setExtensionPrompt.mock.calls[0];
        expect(value).toContain('Retrieved memories:');
        expect(value).toContain('alice traveled to paris');
        // Scope tags are dropped from the injected body too.
        expect(value).not.toMatch(/\[(episodic|working|persona)\]/);
    });
});

describe('interceptor — macro mode', () => {
    beforeEach(() => {
        setSettings({ injectionMode: INJECTION_MODE_MACRO });
    });

    test('clears setExtensionPrompt slot (no double-injection)', async () => {
        seedEntry();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        expect(setExtensionPrompt.mock.calls[0][1]).toBe('');
    });

    test('caches headerless body for the macro to read', async () => {
        seedEntry();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        const cached = getMemoryBody('chat-A');
        // No "Retrieved memories:" preamble, no scope tags—macro users wrap
        // the body in their own prompt phrasing and the model doesn't need
        // STARmem's internal taxonomy.
        expect(cached).not.toContain('Retrieved memories');
        expect(cached).not.toMatch(/\[(episodic|working|persona)\]/);
        expect(cached).toContain('alice traveled to paris');
        expect(cached).toMatch(/^- alice/);
    });

    test('still runs retrieval (state is persisted, traces logged)', async () => {
        seedEntry();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        const after = /** @type {any} */ (store.get('chat-A'));
        expect(after.runtime?.traces?.length ?? 0).toBeGreaterThan(0);
    });
});

describe('interceptor — off mode', () => {
    beforeEach(() => {
        setSettings({ injectionMode: INJECTION_MODE_OFF });
    });

    test('clears slot and skips retrieval entirely', async () => {
        seedEntry();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        expect(setExtensionPrompt.mock.calls[0][1]).toBe('');
        // No retrieval ⇒ no traces logged for this turn.
        const after = /** @type {any} */ (store.get('chat-A'));
        expect(after?.runtime?.traces ?? []).toHaveLength(0);
    });

    test('clears any stale cached body so macro returns empty', async () => {
        seedEntry();
        // First, populate the cache via a normal run.
        setSettings({ injectionMode: INJECTION_MODE_AUTOMATIC });
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        expect(getMemoryBody('chat-A')).not.toBe('');
        // Then flip to off: cache must clear on next turn.
        setSettings({ injectionMode: INJECTION_MODE_OFF });
        setExtensionPrompt.mockClear();
        await starmemInterceptor(makeChat(), 4096, () => {}, 'normal');
        expect(getMemoryBody('chat-A')).toBe('');
    });
});
