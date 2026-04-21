/**
 * UI-scoped constants for Phase 8 (SillyTavern Integration).
 *
 * @module integration/constants
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

/** extension_settings key for global STARmem settings. */
export const SETTINGS_KEY = 'STARmem';

/** Schema version for extension_settings['STARmem']. Bump on breaking changes. */
export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * Defaults applied when extension_settings['STARmem'] is missing fields.
 * Any missing field is filled from here at load time; the saved object is
 * then re-persisted so subsequent reads are complete.
 *
 * @type {Readonly<{
 *   schemaVersion: number,
 *   profileId: string,
 *   embedProfileId: string,
 *   bufferSize: number,
 *   idleTimeout: number,
 *   scorerId: string,
 *   extractionModelLabel: string,
 *   tracesMaxLen: number,
 *   debugMode: boolean,
 * }>}
 */
export const SETTINGS_DEFAULTS = Object.freeze({
    schemaVersion: 1,
    profileId: '',
    embedProfileId: '',
    bufferSize: 5,
    idleTimeout: 60_000,
    scorerId: 'default',
    extractionModelLabel: '',
    tracesMaxLen: 128,
    debugMode: false,
});

/** Settings bounds — enforced by validators in settings.js. */
export const SETTINGS_BOUNDS = Object.freeze({
    bufferSize: { min: 1, max: 50 },
    idleTimeout: { min: 5_000, max: 600_000 },
    tracesMaxLen: { min: 16, max: 1024 },
});

/** Memory injection marker — stamped onto `extra` so we can identify + skip
 *  previously-injected messages if the same interceptor runs twice on a chat
 *  slice (defensive; ST copies chat into coreChat before calling us, so in
 *  practice we never see our own injections again). */
export const INJECTION_KEY = 'STARmem:memory';

/** Role for the injected memory message. */
export const INJECTION_ROLE = 'system';

/** Frozen list of Memory Viewer tab IDs (render order).
 *  Matches spec §8: Working / Episodic / Persona / Graph / Traces. */
export const VIEWER_TABS = Object.freeze([
    'working',
    'episodic',
    'persona',
    'graph',
    'traces',
]);

/** DOM id prefix for everything rendered by the viewer. Every class name and
 *  id used by Phase 8 DOM must start with this prefix. Enforced at test time
 *  by a grep invariant in tests/integration/integration/no-leaky-css.test.js. */
export const CSS_PREFIX = 'starmem';
