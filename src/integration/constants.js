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
 * Stable key registered with ST's setExtensionPrompt. ST uses this to look
 * up + replace our injection on each call; same key across calls means we
 * overwrite ourselves, not stack.
 */
export const INJECTION_PROMPT_KEY = 'STARmem';

/**
 * Chat-depth for memory injection, counted from the end of the chat array.
 * 4 matches ST's default for in-chat injections (slash-commands.js).
 *
 * @see src/integration/interceptor.js
 */
export const INJECTION_DEPTH = 4;

/**
 * ST's `extension_prompt_types`. Mirrored locally as numeric literals to avoid
 * importing from `script.js` (which is loaded by ST itself, not via our module
 * graph). Source of truth: `public/script.js#extension_prompt_types`.
 */
export const INJECTION_POSITION_IN_PROMPT = 0;
export const INJECTION_POSITION_IN_CHAT = 1;

/**
 * ST's `extension_prompt_roles`. Mirrored locally for the same reason as
 * INJECTION_POSITION_*. Source of truth: `public/script.js#extension_prompt_roles`.
 */
export const INJECTION_ROLE_SYSTEM = 0;
export const INJECTION_ROLE_USER = 1;
export const INJECTION_ROLE_ASSISTANT = 2;

/**
 * Injection mode (settings.injectionMode):
 *   'automatic' — STARmem registers the memory body via setExtensionPrompt
 *                 at the configured position/depth/role. Default; matches
 *                 prior behaviour.
 *   'macro'     — STARmem only computes the memory body; placement is the
 *                 user's responsibility via the {{starmem-memories}} macro
 *                 in their preset. setExtensionPrompt is cleared so the two
 *                 surfaces never stack.
 *   'off'       — no retrieval, no injection. Macro returns ''.
 */
export const INJECTION_MODE_AUTOMATIC = 'automatic';
export const INJECTION_MODE_MACRO = 'macro';
export const INJECTION_MODE_OFF = 'off';
export const INJECTION_MODES = Object.freeze([
    INJECTION_MODE_AUTOMATIC,
    INJECTION_MODE_MACRO,
    INJECTION_MODE_OFF,
]);

/** Macro name registered with ST's MacrosParser. Resolves at substitution
 *  time to the most recent retrieval body for the active chat. */
export const MACRO_NAME = 'starmem-memories';

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
 *   injectionMode: 'automatic'|'macro'|'off',
 *   injectionPosition: number,
 *   injectionDepth: number,
 *   injectionRole: number,
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
    injectionMode: INJECTION_MODE_AUTOMATIC,
    injectionPosition: INJECTION_POSITION_IN_CHAT,
    injectionDepth: INJECTION_DEPTH,
    injectionRole: INJECTION_ROLE_SYSTEM,
});

/** Settings bounds — enforced by validators in settings.js. */
export const SETTINGS_BOUNDS = Object.freeze({
    bufferSize: { min: 1, max: 50 },
    idleTimeout: { min: 5_000, max: 600_000 },
    tracesMaxLen: { min: 16, max: 1024 },
    injectionDepth: { min: 0, max: 10 },
});

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
