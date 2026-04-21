/**
 * Global STARmem settings — persisted in extension_settings['STARmem'].
 *
 * All reads go through getSettings(); all writes through setSettings(patch).
 * Missing fields are filled from SETTINGS_DEFAULTS on first load and the
 * result is re-persisted so subsequent callers see a complete object.
 *
 * @module integration/settings
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import {
    SETTINGS_KEY, SETTINGS_DEFAULTS, SETTINGS_BOUNDS,
} from './constants.js';
import { setScorer } from '../retrieval/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:settings');

/**
 * @typedef {{
 *   schemaVersion: number,
 *   profileId: string,
 *   embedProfileId: string,
 *   bufferSize: number,
 *   idleTimeout: number,
 *   scorerId: string,
 *   extractionModelLabel: string,
 *   tracesMaxLen: number,
 *   debugMode: boolean,
 * }} Settings
 */

/**
 * @typedef {object} STContext
 * @property {Record<string, any>} extensionSettings
 * @property {() => void} saveSettingsDebounced
 */

/** @type {STContext | null} */
let testContext = null;

/**
 * Test-only: inject a fake ST context. Production callers must not invoke.
 * @param {STContext} ctx
 */
export function _setContextForTests(ctx) { testContext = ctx; }

/** Test-only: clear injected context so production resolution runs again. */
export function _resetContextForTests() { testContext = null; }

/** @returns {STContext} */
function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') {
        throw new Error('[STARmem] SillyTavern.getContext() unavailable; cannot access extension_settings');
    }
    const ctx = st.getContext();
    if (!ctx || typeof ctx !== 'object') {
        throw new Error('[STARmem] getContext() returned non-object');
    }
    return /** @type {STContext} */ (ctx);
}

/** Clamp n into [min, max]. */
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

/**
 * Validate & clamp a candidate settings object. Missing fields → defaults,
 * out-of-bounds numbers → clamped, unknown scorerId → 'default' with a warn.
 *
 * Note on `setScorer`: the plan originally used `getScorer(id)` to probe the
 * registry, but the real `getScorer()` signature takes no args and returns
 * the currently-active scorer. We use `setScorer(id)` instead, which throws
 * on unknown ids — the side-effect of activating the configured scorer is
 * intentional: loading settings should make the configured scorer live.
 *
 * @param {Partial<Settings>} candidate
 * @returns {Settings}
 */
export function validateSettings(candidate) {
    const src = candidate && typeof candidate === 'object' ? candidate : {};
    /** @type {Settings} */
    const out = { ...SETTINGS_DEFAULTS, ...src };

    // Schema version — if missing or wrong, treat as fresh and reset.
    if (out.schemaVersion !== SETTINGS_DEFAULTS.schemaVersion) {
        log.warn(`schemaVersion drift (got ${out.schemaVersion}, want ${SETTINGS_DEFAULTS.schemaVersion}); resetting to defaults`);
        return { ...SETTINGS_DEFAULTS };
    }

    // Numeric bounds.
    if (typeof out.bufferSize !== 'number' || !Number.isFinite(out.bufferSize)) {
        out.bufferSize = SETTINGS_DEFAULTS.bufferSize;
    }
    out.bufferSize = clamp(Math.round(out.bufferSize),
        SETTINGS_BOUNDS.bufferSize.min, SETTINGS_BOUNDS.bufferSize.max);

    if (typeof out.idleTimeout !== 'number' || !Number.isFinite(out.idleTimeout)) {
        out.idleTimeout = SETTINGS_DEFAULTS.idleTimeout;
    }
    out.idleTimeout = clamp(Math.round(out.idleTimeout),
        SETTINGS_BOUNDS.idleTimeout.min, SETTINGS_BOUNDS.idleTimeout.max);

    if (typeof out.tracesMaxLen !== 'number' || !Number.isFinite(out.tracesMaxLen)) {
        out.tracesMaxLen = SETTINGS_DEFAULTS.tracesMaxLen;
    }
    out.tracesMaxLen = clamp(Math.round(out.tracesMaxLen),
        SETTINGS_BOUNDS.tracesMaxLen.min, SETTINGS_BOUNDS.tracesMaxLen.max);

    // String fields — coerce to string, allow empty.
    out.profileId = typeof out.profileId === 'string' ? out.profileId : '';
    out.embedProfileId = typeof out.embedProfileId === 'string' ? out.embedProfileId : '';
    out.extractionModelLabel = typeof out.extractionModelLabel === 'string' ? out.extractionModelLabel : '';

    // Boolean.
    out.debugMode = Boolean(out.debugMode);

    // Scorer: must resolve in the retrieval registry, else fall back.
    const scorerId = typeof out.scorerId === 'string' ? out.scorerId : SETTINGS_DEFAULTS.scorerId;
    try {
        setScorer(scorerId);
        out.scorerId = scorerId;
    } catch {
        log.warn(`unknown scorerId "${scorerId}"; falling back to "${SETTINGS_DEFAULTS.scorerId}"`);
        setScorer(SETTINGS_DEFAULTS.scorerId);
        out.scorerId = SETTINGS_DEFAULTS.scorerId;
    }

    return out;
}

/**
 * Load settings (filling defaults + clamping), re-persisting if anything
 * was synthesized.
 *
 * @returns {Settings}
 */
export function getSettings() {
    const ctx = resolveContext();
    const raw = ctx.extensionSettings[SETTINGS_KEY];
    const validated = validateSettings(raw);
    // Re-persist if we had to synthesize or clamp.
    const changed = JSON.stringify(raw) !== JSON.stringify(validated);
    ctx.extensionSettings[SETTINGS_KEY] = validated;
    if (changed && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    return { ...validated };
}

/**
 * Merge-patch the current settings, validate, persist.
 *
 * @param {Partial<Settings>} patch
 * @returns {Settings} the merged + validated result
 */
export function setSettings(patch) {
    const ctx = resolveContext();
    const current = getSettings();
    const merged = validateSettings({ ...current, ...(patch || {}) });
    ctx.extensionSettings[SETTINGS_KEY] = merged;
    if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    return { ...merged };
}

/** Force-reset to defaults. Used by the Settings UI "Reset" button. */
export function resetSettings() {
    const ctx = resolveContext();
    const defaults = { ...SETTINGS_DEFAULTS };
    ctx.extensionSettings[SETTINGS_KEY] = defaults;
    if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
    return defaults;
}
