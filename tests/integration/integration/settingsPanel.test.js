/** @jest-environment jsdom */
/**
 * Settings panel — profile dropdowns, sliders, Reset, Open-Viewer button.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    renderSettingsPanel, getConnectionProfiles, getAvailableScorerIds,
    _setContextForTests, _resetContextForTests,
} from '../../../src/integration/settingsPanel.js';
import {
    _setContextForTests as _setSettingsCtx,
    _resetContextForTests as _resetSettingsCtx,
} from '../../../src/integration/settings.js';
import { SETTINGS_KEY, SETTINGS_DEFAULTS } from '../../../src/integration/constants.js';
import { _resetScorerForTests } from '../../../src/retrieval/scorer.js';

function makeContext({ profiles = [] } = {}) {
    return {
        extensionSettings: {
            connectionManager: { profiles },
        },
        saveSettingsDebounced: jest.fn(),
        renderExtensionTemplateAsync: null,  // forces fallback template
    };
}

/** @type {ReturnType<typeof makeContext>} */
let ctx;
/** @type {HTMLElement} */
let parent;

beforeEach(() => {
    ctx = makeContext({
        profiles: [
            { id: 'p1', name: 'Claude Sonnet', api: 'openai' },
            { id: 'p2', name: 'Gemma Local', api: 'textgenerationwebui' },
        ],
    });
    _setContextForTests(ctx);
    _setSettingsCtx({
        extensionSettings: ctx.extensionSettings,
        saveSettingsDebounced: ctx.saveSettingsDebounced,
    });
    _resetScorerForTests();
    parent = document.createElement('div');
    document.body.appendChild(parent);
});

afterEach(() => {
    _resetContextForTests();
    _resetSettingsCtx();
    _resetScorerForTests();
    document.body.innerHTML = '';
});

describe('settingsPanel — discovery', () => {
    test('getConnectionProfiles returns mapped list', () => {
        const profiles = getConnectionProfiles();
        expect(profiles).toHaveLength(2);
        expect(profiles[0]).toEqual({ id: 'p1', name: 'Claude Sonnet', api: 'openai' });
    });

    test('getConnectionProfiles returns empty array when CM missing', () => {
        _setContextForTests({ extensionSettings: {} });
        expect(getConnectionProfiles()).toEqual([]);
    });

    test('getConnectionProfiles filters malformed entries', () => {
        _setContextForTests({
            extensionSettings: {
                connectionManager: {
                    profiles: [
                        { id: 'p1', name: 'Good' },
                        null,
                        { id: 'p2' },  // missing name
                        { name: 'p3' },  // missing id
                    ],
                },
            },
        });
        const profiles = getConnectionProfiles();
        expect(profiles).toHaveLength(1);
        expect(profiles[0].id).toBe('p1');
    });

    test('getAvailableScorerIds always includes default', () => {
        const ids = getAvailableScorerIds();
        expect(ids).toContain('default');
    });
});

describe('settingsPanel — render', () => {
    test('renders into parent', async () => {
        await renderSettingsPanel(parent, {});
        expect(parent.querySelector('.starmem-settings-panel')).not.toBeNull();
    });

    test('populates profile dropdown with profiles + None', async () => {
        await renderSettingsPanel(parent, {});
        const select = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-profile-id'));
        expect(select.options.length).toBe(3);  // None + 2 profiles
        expect(select.options[0].value).toBe('');
        expect(select.options[1].value).toBe('p1');
    });

    test('slider values reflect current settings', async () => {
        ctx.extensionSettings[SETTINGS_KEY] = { ...SETTINGS_DEFAULTS, bufferSize: 8 };
        await renderSettingsPanel(parent, {});
        const slider = /** @type {HTMLInputElement} */ (parent.querySelector('#starmem-settings-buffer-size'));
        expect(slider.value).toBe('8');
    });

    test('slider input event persists changed bufferSize', async () => {
        await renderSettingsPanel(parent, {});
        const slider = /** @type {HTMLInputElement} */ (parent.querySelector('#starmem-settings-buffer-size'));
        slider.value = '12';
        slider.dispatchEvent(new Event('input'));
        expect(ctx.extensionSettings[SETTINGS_KEY].bufferSize).toBe(12);
    });

    test('profile select change persists profileId', async () => {
        await renderSettingsPanel(parent, {});
        const select = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-profile-id'));
        select.value = 'p2';
        select.dispatchEvent(new Event('change'));
        expect(ctx.extensionSettings[SETTINGS_KEY].profileId).toBe('p2');
    });

    test('debug mode checkbox persists', async () => {
        await renderSettingsPanel(parent, {});
        const cb = /** @type {HTMLInputElement} */ (parent.querySelector('#starmem-settings-debug-mode'));
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
        expect(ctx.extensionSettings[SETTINGS_KEY].debugMode).toBe(true);
    });

    test('Reset button restores defaults', async () => {
        ctx.extensionSettings[SETTINGS_KEY] = { ...SETTINGS_DEFAULTS, bufferSize: 20, debugMode: true };
        await renderSettingsPanel(parent, {});
        const btn = /** @type {HTMLButtonElement} */ (parent.querySelector('#starmem-settings-reset'));
        btn.click();
        // Reset calls resetSettings() then re-renders (async). Wait a few ticks.
        await new Promise(r => setTimeout(r, 10));
        expect(ctx.extensionSettings[SETTINGS_KEY]).toEqual(SETTINGS_DEFAULTS);
    });

    test('Open Memory Viewer button invokes callback', async () => {
        const onOpenViewer = jest.fn();
        await renderSettingsPanel(parent, { onOpenViewer });
        const btn = /** @type {HTMLButtonElement} */ (parent.querySelector('#starmem-settings-open-viewer'));
        btn.click();
        expect(onOpenViewer).toHaveBeenCalledTimes(1);
    });

    test('shows warning when no connection profiles configured', async () => {
        _setContextForTests({ extensionSettings: {}, saveSettingsDebounced: jest.fn() });
        _setSettingsCtx({ extensionSettings: {}, saveSettingsDebounced: jest.fn() });
        await renderSettingsPanel(parent, {});
        const warnings = parent.querySelector('#starmem-settings-warnings');
        expect(warnings?.textContent).toContain('Connection Manager');
    });

    test('renderSettingsPanel throws when parent is null', async () => {
        await expect(renderSettingsPanel(/** @type {any} */ (null), {})).rejects.toThrow();
    });

    test('idle timeout slider displays seconds (not ms)', async () => {
        ctx.extensionSettings[SETTINGS_KEY] = { ...SETTINGS_DEFAULTS, idleTimeout: 90_000 };
        await renderSettingsPanel(parent, {});
        const slider = /** @type {HTMLInputElement} */ (parent.querySelector('#starmem-settings-idle-timeout'));
        const label = parent.querySelector('#starmem-settings-idle-timeout-value');
        expect(slider.value).toBe('90');
        expect(label?.textContent).toBe('90s');
    });
});

describe('settingsPanel — injection controls', () => {
    test('mode dropdown reflects current setting and persists changes', async () => {
        ctx.extensionSettings[SETTINGS_KEY] = { ...SETTINGS_DEFAULTS, injectionMode: 'automatic' };
        await renderSettingsPanel(parent, {});
        const sel = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-injection-mode'));
        expect(sel.value).toBe('automatic');
        sel.value = 'macro';
        sel.dispatchEvent(new Event('change'));
        expect(ctx.extensionSettings[SETTINGS_KEY].injectionMode).toBe('macro');
    });

    test('depth slider persists changes', async () => {
        await renderSettingsPanel(parent, {});
        const slider = /** @type {HTMLInputElement} */ (parent.querySelector('#starmem-settings-injection-depth'));
        slider.value = '7';
        slider.dispatchEvent(new Event('input'));
        expect(ctx.extensionSettings[SETTINGS_KEY].injectionDepth).toBe(7);
    });

    test('role select persists changes', async () => {
        await renderSettingsPanel(parent, {});
        const sel = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-injection-role'));
        sel.value = '1';  // USER
        sel.dispatchEvent(new Event('change'));
        expect(ctx.extensionSettings[SETTINGS_KEY].injectionRole).toBe(1);
    });

    test('placement controls disabled when mode != automatic', async () => {
        ctx.extensionSettings[SETTINGS_KEY] = { ...SETTINGS_DEFAULTS, injectionMode: 'macro' };
        await renderSettingsPanel(parent, {});
        const pos = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-injection-position'));
        const depth = /** @type {HTMLInputElement} */ (parent.querySelector('#starmem-settings-injection-depth'));
        const role = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-injection-role'));
        expect(pos.disabled).toBe(true);
        expect(depth.disabled).toBe(true);
        expect(role.disabled).toBe(true);
    });

    test('depth disabled when position != IN_CHAT, even in automatic mode', async () => {
        ctx.extensionSettings[SETTINGS_KEY] = {
            ...SETTINGS_DEFAULTS,
            injectionMode: 'automatic',
            injectionPosition: 0,  // IN_PROMPT
        };
        await renderSettingsPanel(parent, {});
        const pos = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-injection-position'));
        const depth = /** @type {HTMLInputElement} */ (parent.querySelector('#starmem-settings-injection-depth'));
        const role = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-injection-role'));
        expect(pos.disabled).toBe(false);   // position itself stays editable
        expect(depth.disabled).toBe(true);  // depth only meaningful for IN_CHAT
        expect(role.disabled).toBe(false);  // role applies regardless
    });

    test('toggling mode automatic→macro→automatic re-enables placement', async () => {
        await renderSettingsPanel(parent, {});
        const mode = /** @type {HTMLSelectElement} */ (parent.querySelector('#starmem-settings-injection-mode'));
        const depth = /** @type {HTMLInputElement} */ (parent.querySelector('#starmem-settings-injection-depth'));
        expect(depth.disabled).toBe(false);
        mode.value = 'macro';
        mode.dispatchEvent(new Event('change'));
        expect(depth.disabled).toBe(true);
        mode.value = 'automatic';
        mode.dispatchEvent(new Event('change'));
        expect(depth.disabled).toBe(false);
    });
});
