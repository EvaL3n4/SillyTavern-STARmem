/**
 * Settings panel — DOM wiring for settings.html.
 *
 * Reads settings via getSettings(), mutates via setSettings()/resetSettings(),
 * populates dropdowns from ST's connection-manager profile list, exposes a
 * callback for the "Open Memory Viewer" button.
 *
 * Plan-bug fixes:
 * - getAvailableScorerIds originally probed via getScorer(id), but getScorer()
 *   takes no args and returns the *active* scorer. Hardcoding ['default'] is
 *   the honest answer until retrieval/index.js exports listScorers().
 *   TODO(phase-9): add listScorers() to the retrieval barrel.
 *
 * @module integration/settingsPanel
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { getSettings, setSettings, resetSettings } from './settings.js';
import { CSS_PREFIX } from './constants.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:settingsPanel');

/** @type {any} */
let testContext = null;

/** Test-only context injector. */
export function _setContextForTests(ctx) { testContext = ctx; }
/** Test-only: clear injected context. */
export function _resetContextForTests() { testContext = null; }

/** @returns {any} */
function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') return {};
    return st.getContext();
}

/**
 * Read connection profiles from ST. Returns empty array on missing API.
 * Per Decision 10: profiles live at ctx.extensionSettings.connectionManager.profiles.
 *
 * @returns {{ id: string, name: string, api?: string }[]}
 */
export function getConnectionProfiles() {
    const ctx = resolveContext();
    const cm = ctx?.extensionSettings?.connectionManager;
    const profiles = Array.isArray(cm?.profiles) ? cm.profiles : [];
    return profiles
        .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string')
        .map(p => ({ id: p.id, name: p.name, api: p.api }));
}

/**
 * Registered scorer ids. The registry currently only exposes
 * getScorer() (no args, returns the active scorer) and setScorer(id)
 * (throws on unknown). No listing API yet.
 *
 * TODO(phase-9): add listScorers() to retrieval/index.js for proper
 * enumeration. Until then, hardcode 'default' (always registered by
 * retrieval/scorer.js module eval).
 *
 * @returns {string[]}
 */
export function getAvailableScorerIds() {
    return ['default'];
}

/**
 * Render the panel into the given parent. Idempotent — replaces prior content.
 *
 * @param {HTMLElement} parent
 * @param {{ onOpenViewer?: () => void }} [opts]
 */
export async function renderSettingsPanel(parent, opts = {}) {
    if (!parent) throw new Error('[STARmem] renderSettingsPanel: parent is required');

    const ctx = resolveContext();
    const renderer = ctx?.renderExtensionTemplateAsync;
    let html;
    if (typeof renderer === 'function') {
        html = await renderer('third-party/SillyTavern-STARmem', 'settings');
    } else {
        // Test / degraded-env fallback — inline a minimal template so tests
        // don't need a real ST template renderer.
        html = fallbackTemplate();
    }
    parent.innerHTML = html;

    const s = getSettings();
    populateProfileDropdown(`${CSS_PREFIX}-settings-profile-id`, s.profileId);
    populateProfileDropdown(`${CSS_PREFIX}-settings-embed-profile-id`, s.embedProfileId);
    populateScorerDropdown(s.scorerId);
    wireInputs(parent, s);
    wireActions(parent, opts);
    renderWarnings(parent);
}

function fallbackTemplate() {
    return `
        <div class="${CSS_PREFIX}-settings-panel">
            <select id="${CSS_PREFIX}-settings-profile-id"></select>
            <select id="${CSS_PREFIX}-settings-embed-profile-id"></select>
            <select id="${CSS_PREFIX}-settings-scorer"></select>
            <input type="text" id="${CSS_PREFIX}-settings-extraction-label" />
            <input type="range" id="${CSS_PREFIX}-settings-buffer-size" min="1" max="50" />
            <span id="${CSS_PREFIX}-settings-buffer-size-value"></span>
            <input type="range" id="${CSS_PREFIX}-settings-idle-timeout" min="5" max="600" />
            <span id="${CSS_PREFIX}-settings-idle-timeout-value"></span>
            <input type="range" id="${CSS_PREFIX}-settings-traces-max" min="16" max="1024" />
            <span id="${CSS_PREFIX}-settings-traces-max-value"></span>
            <input type="checkbox" id="${CSS_PREFIX}-settings-debug-mode" />
            <button id="${CSS_PREFIX}-settings-reset">Reset</button>
            <button id="${CSS_PREFIX}-settings-open-viewer">Viewer</button>
            <div id="${CSS_PREFIX}-settings-warnings"></div>
        </div>`;
}

/** Populate a profile <select>. */
function populateProfileDropdown(id, currentValue) {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById(id));
    if (!select) return;
    const profiles = getConnectionProfiles();
    select.innerHTML = '';
    // Always add a "None" option first.
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— None —';
    select.appendChild(none);
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.api ? `${p.name} (${p.api})` : p.name;
        select.appendChild(opt);
    }
    select.value = currentValue || '';
}

/** Populate the scorer <select>. */
function populateScorerDropdown(currentValue) {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-scorer`));
    if (!select) return;
    const ids = getAvailableScorerIds();
    select.innerHTML = '';
    for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
    }
    select.value = ids.includes(currentValue) ? currentValue : 'default';
}

/** Attach input event handlers. */
function wireInputs(parent, initial) {
    const bufSlider = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-buffer-size`));
    const bufLabel = document.getElementById(`${CSS_PREFIX}-settings-buffer-size-value`);
    if (bufSlider) {
        bufSlider.value = String(initial.bufferSize);
        if (bufLabel) bufLabel.textContent = String(initial.bufferSize);
        bufSlider.addEventListener('input', () => {
            const v = Number(bufSlider.value);
            if (bufLabel) bufLabel.textContent = String(v);
            setSettings({ bufferSize: v });
        });
    }

    const idleSlider = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-idle-timeout`));
    const idleLabel = document.getElementById(`${CSS_PREFIX}-settings-idle-timeout-value`);
    if (idleSlider) {
        const seconds = Math.round(initial.idleTimeout / 1000);
        idleSlider.value = String(seconds);
        if (idleLabel) idleLabel.textContent = `${seconds}s`;
        idleSlider.addEventListener('input', () => {
            const v = Number(idleSlider.value);
            if (idleLabel) idleLabel.textContent = `${v}s`;
            setSettings({ idleTimeout: v * 1000 });
        });
    }

    const tracesSlider = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-traces-max`));
    const tracesLabel = document.getElementById(`${CSS_PREFIX}-settings-traces-max-value`);
    if (tracesSlider) {
        tracesSlider.value = String(initial.tracesMaxLen);
        if (tracesLabel) tracesLabel.textContent = String(initial.tracesMaxLen);
        tracesSlider.addEventListener('input', () => {
            const v = Number(tracesSlider.value);
            if (tracesLabel) tracesLabel.textContent = String(v);
            setSettings({ tracesMaxLen: v });
        });
    }

    const profile = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-profile-id`));
    if (profile) {
        profile.addEventListener('change', () => {
            setSettings({ profileId: profile.value });
        });
    }

    const embed = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-embed-profile-id`));
    if (embed) {
        embed.addEventListener('change', () => {
            setSettings({ embedProfileId: embed.value });
        });
    }

    const scorer = /** @type {HTMLSelectElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-scorer`));
    if (scorer) {
        scorer.addEventListener('change', async () => {
            setSettings({ scorerId: scorer.value });
            // Also hot-swap the active scorer. setSettings() already validates
            // and activates via setScorer(), so this is belt-and-suspenders —
            // but dynamic import keeps the DOM panel from pulling retrieval
            // into its static dep graph.
            try {
                const { setScorer } = await import('../retrieval/index.js');
                setScorer(scorer.value);
            } catch (err) {
                log.warn(`setScorer failed: ${err?.message || err}`);
            }
        });
    }

    const label = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-extraction-label`));
    if (label) {
        label.value = initial.extractionModelLabel;
        label.addEventListener('change', () => {
            setSettings({ extractionModelLabel: label.value });
        });
    }

    const debug = /** @type {HTMLInputElement | null} */ (document.getElementById(`${CSS_PREFIX}-settings-debug-mode`));
    if (debug) {
        debug.checked = initial.debugMode;
        debug.addEventListener('change', () => {
            setSettings({ debugMode: debug.checked });
        });
    }
}

/** Attach action button handlers. */
function wireActions(parent, opts) {
    const reset = document.getElementById(`${CSS_PREFIX}-settings-reset`);
    if (reset) {
        reset.addEventListener('click', () => {
            resetSettings();
            // Re-render with new defaults.
            renderSettingsPanel(parent, opts);
        });
    }

    const openViewer = document.getElementById(`${CSS_PREFIX}-settings-open-viewer`);
    if (openViewer && typeof opts.onOpenViewer === 'function') {
        openViewer.addEventListener('click', () => opts.onOpenViewer());
    }
}

/** Render warnings about missing ST APIs.
 *
 * Signature takes `parent` for symmetry with other helpers (wireInputs,
 * wireActions) even though lookup is by id from document — so the unused
 * name is prefixed with `_` to satisfy lint.
 */
function renderWarnings(_parent) {
    const box = document.getElementById(`${CSS_PREFIX}-settings-warnings`);
    if (!box) return;
    const warnings = [];
    const profiles = getConnectionProfiles();
    if (profiles.length === 0) {
        warnings.push('Connection Manager has no profiles configured — LLM-backed consolidation will fail.');
    }
    box.innerHTML = '';
    for (const w of warnings) {
        const p = document.createElement('p');
        p.className = `${CSS_PREFIX}-settings-warning`;
        p.textContent = w;
        box.appendChild(p);
    }
}
