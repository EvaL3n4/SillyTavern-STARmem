/**
 * Settings persistence — validation, defaults, clamping, scorer fallback.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    getSettings, setSettings, resetSettings, validateSettings,
    _setContextForTests, _resetContextForTests,
} from '../../../src/integration/settings.js';
import {
    SETTINGS_KEY, SETTINGS_DEFAULTS, SETTINGS_BOUNDS,
} from '../../../src/integration/constants.js';
import { registerScorer, _resetScorerForTests } from '../../../src/retrieval/scorer.js';

/** @type {{ extensionSettings: Record<string, any>, saveSettingsDebounced: jest.Mock }} */
let ctx;

beforeEach(() => {
    ctx = {
        extensionSettings: {},
        saveSettingsDebounced: jest.fn(),
    };
    _setContextForTests(ctx);
});

afterEach(() => {
    _resetContextForTests();
    _resetScorerForTests();
});

describe('integration/settings', () => {
    test('getSettings returns defaults and persists when store is empty', () => {
        const s = getSettings();
        expect(s).toEqual(SETTINGS_DEFAULTS);
        expect(ctx.extensionSettings[SETTINGS_KEY]).toEqual(SETTINGS_DEFAULTS);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('getSettings does not re-persist when stored value already matches', () => {
        ctx.extensionSettings[SETTINGS_KEY] = { ...SETTINGS_DEFAULTS };
        ctx.saveSettingsDebounced.mockClear();
        getSettings();
        expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('setSettings merges patch onto current and persists', () => {
        const s = setSettings({ bufferSize: 7, debugMode: true });
        expect(s.bufferSize).toBe(7);
        expect(s.debugMode).toBe(true);
        expect(s.profileId).toBe(SETTINGS_DEFAULTS.profileId);
        expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
    });

    test('setSettings clamps bufferSize to bounds', () => {
        expect(setSettings({ bufferSize: 999 }).bufferSize).toBe(SETTINGS_BOUNDS.bufferSize.max);
        expect(setSettings({ bufferSize: 0 }).bufferSize).toBe(SETTINGS_BOUNDS.bufferSize.min);
    });

    test('setSettings clamps idleTimeout to bounds', () => {
        expect(setSettings({ idleTimeout: 1 }).idleTimeout).toBe(SETTINGS_BOUNDS.idleTimeout.min);
        expect(setSettings({ idleTimeout: 10_000_000 }).idleTimeout).toBe(SETTINGS_BOUNDS.idleTimeout.max);
    });

    test('setSettings clamps tracesMaxLen to bounds', () => {
        expect(setSettings({ tracesMaxLen: 2 }).tracesMaxLen).toBe(SETTINGS_BOUNDS.tracesMaxLen.min);
        expect(setSettings({ tracesMaxLen: 5000 }).tracesMaxLen).toBe(SETTINGS_BOUNDS.tracesMaxLen.max);
    });

    test('setSettings rounds non-integer numerics', () => {
        expect(setSettings({ bufferSize: 3.7 }).bufferSize).toBe(4);
    });

    test('setSettings coerces string fields to strings', () => {
        const s = setSettings(/** @type {any} */ ({ profileId: 42 }));
        expect(s.profileId).toBe(''); // non-string → default
    });

    test('setSettings coerces debugMode to boolean', () => {
        expect(setSettings(/** @type {any} */ ({ debugMode: 'yes' })).debugMode).toBe(true);
        expect(setSettings(/** @type {any} */ ({ debugMode: 0 })).debugMode).toBe(false);
    });

    test('unknown scorerId falls back to "default" with warn', () => {
        const s = setSettings({ scorerId: 'nonexistent' });
        expect(s.scorerId).toBe('default');
    });

    test('known registered scorerId is preserved', () => {
        registerScorer('custom', (_entry, _query, _ctx) => 1);
        const s = setSettings({ scorerId: 'custom' });
        expect(s.scorerId).toBe('custom');
    });

    test('schemaVersion drift resets to defaults', () => {
        ctx.extensionSettings[SETTINGS_KEY] = { schemaVersion: 99, bufferSize: 50 };
        const s = getSettings();
        expect(s).toEqual(SETTINGS_DEFAULTS);
    });

    test('resetSettings restores defaults regardless of prior state', () => {
        setSettings({ bufferSize: 20, debugMode: true });
        const r = resetSettings();
        expect(r).toEqual(SETTINGS_DEFAULTS);
        expect(ctx.extensionSettings[SETTINGS_KEY]).toEqual(SETTINGS_DEFAULTS);
    });

    test('validateSettings handles null / non-object inputs gracefully', () => {
        expect(validateSettings(/** @type {any} */ (null))).toEqual(SETTINGS_DEFAULTS);
        expect(validateSettings(/** @type {any} */ (undefined))).toEqual(SETTINGS_DEFAULTS);
        expect(validateSettings(/** @type {any} */ ('garbage'))).toEqual(SETTINGS_DEFAULTS);
    });

    test('getSettings throws if SillyTavern context is unavailable', () => {
        _resetContextForTests();
        // With no injected context and no globalThis.SillyTavern, must throw.
        const orig = /** @type {any} */ (globalThis).SillyTavern;
        try {
            delete /** @type {any} */ (globalThis).SillyTavern;
            expect(() => getSettings()).toThrow(/getContext\(\) unavailable/);
        } finally {
            if (orig !== undefined) /** @type {any} */ (globalThis).SillyTavern = orig;
        }
    });
});
