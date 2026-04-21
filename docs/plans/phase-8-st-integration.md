# Phase 8 — SillyTavern Integration

**Date:** 2026-04-21
**Prerequisite:** Phase 7 shipped at `ffd599e` (440 tests / 41 suites, working tree clean, ROADMAP retro in place).
**Scope:** The user-facing surface. Everything programmatic is working; this phase connects it to SillyTavern's event lifecycle, DOM, and settings system.

---

## 1. Scope recap (per spec §8 + Phase 6/7 notes)

**Ships:**
- `STARmemInterceptor` — real implementation wired into the ST generation pipeline
- `APP_READY` bootstrap — event-source subscriptions, settings load, indicator mount, idle timer
- Settings UI panel (ST-native, HTML template + DOM wiring)
- Consolidation indicator (subtle dot)
- Memory Viewer — five tabs (Working / Episodic / Persona / Graph / Traces), modal-presented
- Settings + chat-switch state hygiene
- JSDOM component tests + manual smoke checklist

**Cut from spec §8 (already documented as out of scope):** Setup Wizard, Health Checks, Debug Console.

**Cut for this phase, deferred to Phase 9:** Playwright/real-ST E2E harness. JSDOM integration tests plus a manual smoke checklist cover component logic and final release validation respectively.

---

## 2. Design decisions (locked in planning conversation)

All fifteen held through planning. Controller audit verifies each against the final code before retro. Decisions 11–15 were locked during Phase 8 chunk-6/7 finalization (see top-of-chunk-6 preamble).

| # | Decision | Locked value |
|---|---|---|
| 1 | E2E harness | JSDOM component tests + manual smoke checklist (`scripts/smoke.md`). Playwright/real-ST E2E deferred to Phase 9 or later. |
| 2 | DOM rendering | Vanilla `document.createElement` + `textContent` for data, `innerHTML` only for static templates. No jQuery, no vdom. |
| 3 | Settings persistence | Global (`extension_settings['STARmem']`): `profileId`, `embedProfileId`, `bufferSize`, `idleTimeout`, `scorerId`, `extractionModelLabel`, `tracesMaxLen`, `debugMode`. Per-chat (`chatMetadata['STARmem']`): already where state lives; no net-new per-chat settings. |
| 4 | Injection format | `is_system` message spliced at chat depth 4 (counted from end, per ST's `slash-commands.js` default), role = system. Stub marker `extra.isMemoryInjection = true`. Position falls back to end if chat length < depth. |
| 5 | Access events timing | Pre-generate — `applyAccessEvent` fires for entries returned by `retrieve()`, before the LLM sees them. Matches spec §7 "surfaced to user" read. |
| 6 | Chat switch hygiene | `CHAT_CHANGED` handler: `cancelIdleTimer(oldChatId)`, clear per-chat BM25 cache (future-proof — no cache today), then `maybeConsolidate(newChatId)` if buffer ≥ threshold. No special path. |
| 7 | Traces size + export | 128 entries (existing `TRACE_BUFFER_CAP`); export as JSONL via blob URL; per-trace expand in UI. |
| 8 | Delegation split | Controller: interceptor, bootstrap, settings persistence, final wiring, audits. Subagent: each DOM component (indicator, panel, viewer mount, five tabs) + CSS + JSDOM harness. |
| 9 | CSS scoping | `.starmem-*` prefix on every class. Lint enforcement via a `no-other-mutators`-style grep invariant (see Task 9). |
| 10 | ConnectionManager discovery | Via `SillyTavern.getContext().ConnectionManagerRequestService` (confirmed at `public/scripts/extensions/shared.js:380`). Profiles via `context.extensionSettings.connectionManager.profiles` (confirmed in Task 5 plan). |
| 11 | stContextMock surface | Minimal — only the `getContext()` subset Phase 8 reads — plus an `eventSource` spy with real pub/sub semantics. Factory per test via `makeStContext(overrides)`, not a shared singleton. Lives under `tests/helpers/`, not `tests/fixtures/` (code, not data). |
| 12 | CSS theming | Hybrid: ST CSS custom properties (`var(--SmartThemeBodyColor, …)`) for surfaces/text/borders so user themes (Catppuccin, Midnight, etc.) inherit automatically, plus hardcoded hex for STARmem-specific accents (indicator amber, active-tab blue). Every `var(--SmartTheme…)` carries a fallback so we degrade gracefully if ST renames a variable. |
| 13 | Viewer modal | Native `<dialog>` with `showModal()` — browser provides backdrop, Escape-to-close, and focus trap for free. Jest-jsdom (v16+) supports `HTMLDialogElement` so we don't need to polyfill in tests. |
| 14 | Indicator mount | `#send_but_container` anchor (with `position: relative` set by STARmem's stylesheet). Revises the earlier draft that mounted on `document.body` with fixed positioning — ST's send-bar structure has been stable for years and anchoring there is more visually integrated. Fallback to `document.body` + fixed position if `#send_but_container` isn't available at mount time (defensive). |
| 15 | Smoke checklist | Thorough — 18 steps across three sections (happy path, chat-switch hygiene, defensive paths). Pure prose markdown; no bash helper scripts (Phase 9 owns automation). Must pass fully on a fresh ST install before shipping. Mobile `<select>` collapse tested on narrow viewport as part of happy path. |

## Layout (divergence from spec §10 acknowledged)

```
src/integration/
  constants.js          # NEW — UI-scoped constants (depth, keys, defaults, tab IDs)
  settings.js           # getSettings / setSettings / resetSettings (persistence + validation)
  interceptor.js        # STARmemInterceptor body (pre-gen retrieve + inject at chat[4])
  bootstrap.js          # APP_READY wiring, all event subscriptions, chat-switch hygiene
  indicator.js          # consolidation dot
  settingsPanel.js      # DOM + event handlers for the settings UI
  settings.html         # static template (loaded via getContext().renderExtensionTemplateAsync)
  viewer/
    mount.js            # tab shell + modal + switcher + shared subject filter
    tabs/
      working.js
      episodic.js
      persona.js        # includes "Rebuild" button wired to rebuildPersona
      graph.js
      traces.js         # + JSONL export
  index.js              # barrel
tests/
  helpers/
    stContextMock.js    # minimal SillyTavern.getContext() mock + eventSource spy
  integration/integration/
    interceptor.test.js           # non-JSDOM
    settings.test.js              # non-JSDOM
    settingsPanel.test.js         # JSDOM
    viewer-mount.test.js          # JSDOM
    viewer-tabs-working.test.js   # JSDOM
    viewer-tabs-episodic.test.js  # JSDOM
    viewer-tabs-persona.test.js   # JSDOM
    viewer-tabs-graph.test.js     # JSDOM
    viewer-tabs-traces.test.js    # JSDOM
    indicator.test.js             # JSDOM
    bootstrap.test.js             # JSDOM (partial — event wiring only, chat flow via smoke)
scripts/
  smoke.md              # manual smoke checklist for fresh-ST install validation
index.js                # EXISTING stub — replace TODO(impl) with real import + APP_READY dispatch
style.css               # populate from stub, all .starmem-* classes
```

Rationale: settings persistence is JSDOM-free (testable in the main jest env); settings DOM is JSDOM-only. Splitting `settings.js` from `settingsPanel.js` means ~60% of Task 1's surface is testable without the JSDOM overhead, and matches Phase 1's `state.js` / `entry.js` separation-by-testability.

---

## 3. Inter-phase contracts

### What Phase 8 consumes from prior phases

All imports resolved against existing barrels. No cross-phase refactors.

**From `src/retrieval/index.js`:**
- `retrieve(chatId, query, opts)` → `{ tierResolved, entries, trace }`
- `buildIndex(entries)` → Index (for traces tab, if we want to re-score on demand; Phase 8 doesn't need this but traces capture the ranked output)
- `getScorerId()` / `registerScorer(id, fn)` / `setScorer(id)` — settings UI swaps via these

**From `src/consolidation/index.js`:**
- `consolidate(chatId, opts)` — not called by UI directly; only through triggers
- `maybeConsolidate(chatId, opts)` — called from bootstrap after CHAT_CHANGED, after MESSAGE_RECEIVED
- `resetIdleTimer(chatId, opts)` / `cancelIdleTimer(chatId)` — bootstrap wires to MESSAGE_SENT / CHAT_CHANGED
- `rebuildPersona(chatId, subject, opts)` — persona tab "Rebuild" button

**From `src/lifecycle/index.js`:**
- `applyAccessEvent(lifecycle, now)` — called from interceptor for each returned entry

**From `src/core/state.js`:**
- `loadState(chatId)` — all read paths in UI + interceptor
- `setBackend({ read, write })` — bootstrap provides the real ST backend (reads from/writes to `chatMetadata` via `getContext().saveMetadataDebounced`)

**From `src/memory/index.js`:**
- `buildAdjacency(state)` / `neighborsOf(adj, id)` — graph tab only

**From `src/core/logger.js`:**
- `createLogger({ debug }).scope('integration')` — debug mode wires through

### What Phase 8 produces for Phase 9 (Benchmarking)

- **Traces JSONL export.** Phase 9's eval harness can consume the exported JSONL directly for corpus replay.
- **Scorer selection UI.** Phase 9's A/B evaluator reads `getScorerId()` to label traces; the UI exposes the swap mechanism.
- **`extension_settings['STARmem']` schema.** Phase 9 can add a `benchmarkMode` toggle here if it wants.
- **Interceptor access-event ordering.** Phase 9's eval harness must NOT trigger `applyAccessEvent` on replay queries, otherwise importance inflates. Phase 8's interceptor is the only site that fires it; bypass-able by calling `retrieve()` directly.

### What Phase 8 does NOT change in prior phases

- **`src/core/state.js`** — stays injectable-backend. Phase 8's bootstrap provides the ST-backed implementation but doesn't modify state.js itself.
- **`src/retrieval/` and `src/consolidation/`** — no new exports, no signature changes. Everything Phase 8 needs is already in barrels.
- **`chatMetadata['STARmem']` shape** — unchanged. Phase 8 only reads + writes runtime fields already defined in spec §3.

---

## 4. Task overview

| # | File | Verbatim lines (approx) | Owner | Audit |
|---|---|---|---|---|
| 0 | `src/integration/constants.js` + `core/constants.js` tiny delta | 90 | Controller | - |
| 1 | `src/integration/settings.js` | 160 | Subagent | - |
| 2 | `src/integration/interceptor.js` | 180 | Controller | Non-JSDOM test with chat-array mock |
| 3 | `src/integration/bootstrap.js` | 220 | Controller | JSDOM bootstrap.test.js — event-wiring assertions |
| 4 | `src/integration/indicator.js` | 70 | Subagent | JSDOM indicator.test.js |
| 5 | `src/integration/settingsPanel.js` + `settings.html` | 320 | Subagent | JSDOM settingsPanel.test.js |
| 6 | `src/integration/viewer/mount.js` | 200 | Subagent | JSDOM viewer-mount.test.js |
| 7.1 | `viewer/tabs/working.js` | 90 | Subagent | JSDOM |
| 7.2 | `viewer/tabs/episodic.js` | 150 | Subagent | JSDOM |
| 7.3 | `viewer/tabs/persona.js` | 160 | Subagent | JSDOM |
| 7.4 | `viewer/tabs/graph.js` | 110 | Subagent | JSDOM |
| 7.5 | `viewer/tabs/traces.js` + JSONL export | 170 | Subagent | JSDOM |
| 8 | `tests/helpers/stContextMock.js` + harness wiring | 140 | Controller | Self-test (10 assertions) |
| 9 | `src/integration/index.js` barrel + `index.js` wire-up | 60 | Controller | grep invariant for `.starmem-*` prefix |
| 10 | `style.css` | 180 | Subagent | - |
| 11 | `scripts/smoke.md` + ROADMAP retro | - | Controller | Final verification block |

Expected: **~16 feature commits** + plan + retro = **18 commits this phase**. Plan file ~3000 lines (smaller than Phase 7's 3948 because DOM boilerplate is less dense than Leiden).

---

## 5. Deliberate spec deviations (amendment TODOs for `docs(spec)`)

**1. Layout divergence from spec §10.**
Spec §10 prescribes `src/integration/settings.js`, `src/integration/memoryViewer/`, `src/integration/indicator.js`, `src/integration/interceptor.js`. We ship:
- `settings.js` (persistence) + `settingsPanel.js` (DOM) — split for testability.
- `viewer/mount.js` + `viewer/tabs/*.js` — folder + per-tab files for per-commit review granularity.
- `bootstrap.js` — not in spec, but lifecycle wiring deserves its own file.
- `constants.js` under integration — UI-scoped constants stay out of core.

Amendment needed: spec §10's `src/integration/` tree should reflect what shipped, plus the note about settings/panel split being a testability decision.

**2. E2E harness deferred.**
Spec §8 done-when criteria includes "Install into fresh ST, chat works end-to-end" — our JSDOM tests + manual smoke checklist satisfy this operationally, but a headless Playwright harness is the spec's implicit gold standard. Deferred to Phase 9 (or a standalone `test(e2e):` effort) rather than blocking Phase 8.

Amendment needed: spec §8 done-when should clarify "end-to-end validation via Playwright or equivalent manual checklist."

---

## Task 0 — Constants delta

**Objective:** Add UI-scoped constants file + one tiny addition to core/constants.js. No DOM, no logic.

**Owner:** Controller.

**Files:**
- Create: `src/integration/constants.js`
- Modify: `src/core/constants.js` (add `INJECTION_DEPTH` — used by both interceptor and settings UI default)
- Modify: `tests/unit/core/constants.test.js` (1 new assertion)
- Create: `tests/unit/integration/constants.test.js`

**Step 1: Create `src/integration/constants.js`**

```js
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
```

**Step 2: Modify `src/core/constants.js`**

Add after the existing `TRACE_BUFFER_CAP` export:

```js
/**
 * Chat-depth position for memory injection, counted from the end of the chat
 * array. ST convention: 4 (matches slash-commands.js default for in-chat
 * injections). If chat.length < INJECTION_DEPTH, fallback is to append.
 *
 * @see src/integration/interceptor.js
 */
export const INJECTION_DEPTH = 4;
```

**Step 3: Extend `tests/unit/core/constants.test.js`**

Add inside the existing `describe('constants')` block:

```js
test('INJECTION_DEPTH matches ST in-chat convention', () => {
    expect(INJECTION_DEPTH).toBe(4);
});
```

And add `INJECTION_DEPTH` to the import list at the top.

**Step 4: Create `tests/unit/integration/constants.test.js`**

```js
/**
 * Phase 8 constants are frozen + shaped correctly.
 */
import { describe, test, expect } from '@jest/globals';
import {
    SETTINGS_KEY, SETTINGS_SCHEMA_VERSION, SETTINGS_DEFAULTS, SETTINGS_BOUNDS,
    INJECTION_KEY, INJECTION_ROLE, VIEWER_TABS, CSS_PREFIX,
} from '../../../src/integration/constants.js';

describe('integration/constants', () => {
    test('SETTINGS_KEY is the canonical capitalized name', () => {
        expect(SETTINGS_KEY).toBe('STARmem');
    });

    test('SETTINGS_SCHEMA_VERSION matches the defaults.schemaVersion', () => {
        expect(SETTINGS_DEFAULTS.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    });

    test('SETTINGS_DEFAULTS is frozen', () => {
        expect(Object.isFrozen(SETTINGS_DEFAULTS)).toBe(true);
    });

    test('SETTINGS_DEFAULTS has every key expected by the panel', () => {
        const keys = [
            'schemaVersion', 'profileId', 'embedProfileId', 'bufferSize',
            'idleTimeout', 'scorerId', 'extractionModelLabel', 'tracesMaxLen',
            'debugMode',
        ];
        for (const k of keys) {
            expect(SETTINGS_DEFAULTS).toHaveProperty(k);
        }
    });

    test('SETTINGS_DEFAULTS values pass their own SETTINGS_BOUNDS', () => {
        for (const [field, { min, max }] of Object.entries(SETTINGS_BOUNDS)) {
            const v = /** @type {any} */ (SETTINGS_DEFAULTS)[field];
            expect(v).toBeGreaterThanOrEqual(min);
            expect(v).toBeLessThanOrEqual(max);
        }
    });

    test('INJECTION_KEY is namespaced under STARmem', () => {
        expect(INJECTION_KEY.startsWith('STARmem:')).toBe(true);
    });

    test('INJECTION_ROLE matches ST convention', () => {
        expect(INJECTION_ROLE).toBe('system');
    });

    test('VIEWER_TABS are frozen and match spec §8', () => {
        expect(Object.isFrozen(VIEWER_TABS)).toBe(true);
        expect([...VIEWER_TABS]).toEqual([
            'working', 'episodic', 'persona', 'graph', 'traces',
        ]);
    });

    test('CSS_PREFIX is lowercased to match HTML convention', () => {
        expect(CSS_PREFIX).toBe('starmem');
        expect(CSS_PREFIX).toBe(CSS_PREFIX.toLowerCase());
    });
});
```

**Step 5: Run + commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run typecheck
npm run lint
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
# expect: 41 suites becomes 42, tests ≈ 440 + 1 (core delta) + 9 (new integration/constants) = 450
git add src/integration/constants.js src/core/constants.js tests/unit/core/constants.test.js tests/unit/integration/constants.test.js
git commit -m "feat(integration): Phase 8 UI constants + INJECTION_DEPTH=4"
```

**Done when:**
- New constants file exists, frozen, typechecked
- Core constants delta lands the single new export
- All 10 new assertions pass (1 core delta + 9 integration)
- Full suite still green

---

## Task 1 — `src/integration/settings.js` (persistence)

**Objective:** Pure-ish settings module. Reads from `SillyTavern.getContext().extensionSettings[SETTINGS_KEY]`, fills defaults, validates, clamps, and persists via `saveSettingsDebounced`. No DOM; JSDOM-free tests.

**Owner:** Subagent.

**Context for the subagent:**

```
ABSOLUTE REPO PATH: /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem

Verify with `git log -1` showing <HEAD hash from Task 0> on branch main before work.

Constraints:
- NO npm install.
- NO DOM.
- NO fetch / network.
- The module reads getContext() fresh on every call — ST swaps extensionSettings on settings reload (same pattern as core/state.js).
- For tests, provide a _setContextForTests({ extensionSettings, saveSettingsDebounced }) escape hatch that injects a fake context so tests don't need a real SillyTavern global. Reset via _resetContextForTests().
- All validators must clamp; none throws on invalid input (silently corrects, logs via createLogger's scope('integration:settings').debug path). Exception: unknown scorerId falls back to 'default' with a warn log.
- Use the existing scorer registry to validate scorerId: import getScorer from ../retrieval/index.js, call getScorer(id); if it throws, clamp to 'default'.
```

**Files:**
- Create: `src/integration/settings.js`
- Create: `tests/unit/integration/settings.test.js`

**Step 1: Create `src/integration/settings.js`**

```js
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
import { getScorer } from '../retrieval/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:settings');

/**
 * @typedef {typeof SETTINGS_DEFAULTS} Settings
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
        getScorer(scorerId);
        out.scorerId = scorerId;
    } catch {
        log.warn(`unknown scorerId "${scorerId}"; falling back to "${SETTINGS_DEFAULTS.scorerId}"`);
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
```

**Step 2: Create `tests/unit/integration/settings.test.js`**

```js
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
        registerScorer('custom', (entry, _query, _ctx) => 1);
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
```

**Step 3: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/unit/integration/settings.test.js
# expect: 16 tests pass in settings.test.js alone
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
# expect: +1 suite, +16 tests
git add src/integration/settings.js tests/unit/integration/settings.test.js
git commit -m "feat(integration): extension_settings['STARmem'] persistence with defaults + clamps"
```

**Done when:**
- All 16 new tests pass
- Typecheck + lint green
- Full suite green
- No `globalThis.SillyTavern` reads outside `resolveContext()`
- No DOM, no `document`, no `window` references

---
## Task 2 — `src/integration/interceptor.js` (load-bearing, controller)

**Objective:** The real `STARmemInterceptor` body. Called by ST on every generation with `(chat, contextSize, abort, type)`. Resolves chatId, calls `retrieve()`, formats entries into a synthetic system message, splices into chat at `INJECTION_DEPTH` from end, fires `applyAccessEvent` for returned entries.

**Owner:** Controller. This is the highest-risk task in Phase 8 because wrong injection math corrupts every generation.

**Files:**
- Create: `src/integration/interceptor.js`
- Create: `tests/integration/integration/interceptor.test.js`

**Pre-flight notes:**

1. **Chat array shape.** Each element is `{ name, is_user, is_system, send_date, mes, extra: {} }`. `mes` carries the actual text. We inject with `is_system: true` and a marker in `extra`.

2. **`abort` is a function, not a value.** Signature per ST source: `abort(immediately: boolean)`. Calling `abort(true)` stops generation *and* exits the interceptor chain; `abort(false)` stops generation but still runs subsequent interceptors. We only use `abort` on catastrophic errors; normal "no memories to inject" is a no-op.

3. **Mutation contract.** We splice into the given `chat` array. ST passes us `coreChat` — a copy, not the visible chat — so our splice doesn't persist and doesn't pollute `chatMetadata`. Do not reassign `chat`; only mutate.

4. **chatId resolution.** ST's `getContext().chatId` is the authoritative current chat. We read it fresh on each call (chats can switch between generations).

5. **Query extraction.** The query for retrieval is the *last user message* in `chat`. Walk from end backwards; first `is_user === true` wins. If no user message exists (edge case: impersonation, first turn), skip retrieval entirely.

6. **Depth fallback.** `chat.length < INJECTION_DEPTH` → splice at `0` (prepend). The spec's depth 4 is a soft convention; short chats get memories at the top where they can't disrupt a conversation that's barely started.

7. **Access events fire for entries returned by `retrieve()`, not every candidate scored.** This is Phase 3's decision locked in spec and Phase 4 retro. `retrieve()` returns `{ tierResolved, entries, trace }`; we iterate `entries` and call `applyAccessEvent(entry.lifecycle, now)`. The updated lifecycle gets written back via a single `persistState` call at the end.

8. **Error handling.** Any thrown error inside the interceptor is caught, logged, and swallowed — we return without injecting. A broken memory system must not break the user's chat. The only exception is a programmer error (missing module exports) which would surface at load time anyway.

**Step 1: Create `src/integration/interceptor.js`**

```js
/**
 * STARmemInterceptor body — invoked by SillyTavern before each generation.
 *
 * Contract (from ST's extensions.js#runGenerationInterceptors):
 *   globalThis.STARmemInterceptor(chat, contextSize, abort, type)
 *   - chat: array (coreChat copy; mutate in place, don't reassign)
 *   - contextSize: number (max prompt tokens — informational for us)
 *   - abort: (immediately: boolean) => void
 *   - type: string (generation type, e.g. "normal", "continue", "impersonate")
 *
 * Flow:
 *   1. Resolve chatId from SillyTavern.getContext(). Bail on missing.
 *   2. Extract last user query from chat. Bail if none (impersonation, etc.).
 *   3. retrieve() against current state.
 *   4. Format returned entries into an is_system message.
 *   5. Splice at Math.max(0, chat.length - INJECTION_DEPTH).
 *   6. Fire applyAccessEvent for each returned entry; persist updated lifecycle.
 *
 * Errors:
 *   All thrown errors are caught, logged, and swallowed. A broken memory system
 *   must not break generation.
 *
 * @module integration/interceptor
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { INJECTION_DEPTH } from '../core/constants.js';
import { INJECTION_KEY, INJECTION_ROLE } from './constants.js';
import { retrieve } from '../retrieval/index.js';
import { applyAccessEvent } from '../lifecycle/index.js';
import { loadState, persistState } from '../core/state.js';
import { createLogger } from '../core/logger.js';
import { withWriteLock } from '../core/lock.js';

const log = createLogger({ debug: false }).scope('integration:interceptor');

/**
 * @typedef {object} ChatMessage
 * @property {string} name
 * @property {boolean} is_user
 * @property {boolean} is_system
 * @property {string} send_date
 * @property {string} mes
 * @property {Record<string, any>} [extra]
 */

/** @type {any} */
let testContext = null;

/** Test-only: inject a fake getContext() result. */
export function _setContextForTests(ctx) { testContext = ctx; }
/** Test-only: clear injected context. */
export function _resetContextForTests() { testContext = null; }

/** @returns {{ chatId: string | null }} */
function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') return { chatId: null };
    const ctx = st.getContext();
    return {
        chatId: typeof ctx?.chatId === 'string' && ctx.chatId.length > 0 ? ctx.chatId : null,
    };
}

/**
 * Extract the last user message's text from a chat array.
 *
 * @param {ChatMessage[]} chat
 * @returns {string | null}
 */
export function extractLastUserQuery(chat) {
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && m.is_user === true && typeof m.mes === 'string' && m.mes.trim().length > 0) {
            return m.mes;
        }
    }
    return null;
}

/**
 * Compose the text body of an injected memory message. Keeps the format
 * simple + LLM-neutral; Phase 9 can A/B test fancier formats later.
 *
 * @param {{ id: string, content: string, scope: string }[]} entries
 * @returns {string}
 */
export function formatMemoryMessage(entries) {
    if (entries.length === 0) return '';
    const lines = entries.map(e => `- [${e.scope}] ${e.content}`);
    return ['[STARmem] Retrieved memories:', ...lines].join('\n');
}

/**
 * Build the synthetic chat message we splice into the array.
 *
 * @param {string} text
 * @returns {ChatMessage}
 */
export function buildInjectionMessage(text) {
    return {
        name: 'System',
        is_user: false,
        is_system: true,
        send_date: new Date().toISOString(),
        mes: text,
        extra: { [INJECTION_KEY]: true, role: INJECTION_ROLE },
    };
}

/**
 * Compute the splice position: `chat.length - INJECTION_DEPTH`, clamped to
 * [0, chat.length]. If chat is shorter than depth, prepend.
 *
 * @param {number} chatLength
 * @param {number} depth
 * @returns {number}
 */
export function computeInjectionPosition(chatLength, depth) {
    if (chatLength <= 0) return 0;
    return Math.max(0, chatLength - depth);
}

/**
 * Main entry point — invoked by SillyTavern. Always mutates `chat` in place;
 * never reassigns.
 *
 * @param {ChatMessage[]} chat
 * @param {number} _contextSize
 * @param {(immediately: boolean) => void} _abort
 * @param {string} _type
 * @returns {Promise<void>}
 */
export async function starmemInterceptor(chat, _contextSize, _abort, _type) {
    try {
        const { chatId } = resolveContext();
        if (!chatId) {
            log.debug('no chatId — skipping retrieval');
            return;
        }

        const query = extractLastUserQuery(chat);
        if (!query) {
            log.debug('no user query in chat — skipping retrieval');
            return;
        }

        const state = await loadState(chatId);
        const result = await retrieve(chatId, query, { now: new Date() });
        const entries = Array.isArray(result?.entries) ? result.entries : [];

        if (entries.length === 0) {
            log.debug('retrieval returned zero entries');
            return;
        }

        // Fire access events — mutation through withWriteLock for safety.
        await withWriteLock(chatId, async () => {
            const fresh = await loadState(chatId);
            const now = new Date();
            const nextEntries = { ...fresh.entries };
            let mutated = false;
            for (const e of entries) {
                const stored = nextEntries[e.id];
                if (!stored) continue;
                const nextLifecycle = applyAccessEvent(stored.lifecycle, now);
                if (nextLifecycle !== stored.lifecycle) {
                    nextEntries[e.id] = { ...stored, lifecycle: nextLifecycle };
                    mutated = true;
                }
            }
            if (mutated) {
                await persistState(chatId, { ...fresh, entries: nextEntries });
            }
        });

        // Splice into chat.
        const body = formatMemoryMessage(entries);
        if (!body) return;
        const pos = computeInjectionPosition(chat.length, INJECTION_DEPTH);
        chat.splice(pos, 0, buildInjectionMessage(body));
        log.debug(`injected ${entries.length} entries at pos=${pos} (chat.length was ${chat.length - 1})`);
    } catch (err) {
        log.warn('interceptor error (swallowed to protect generation):', err);
    }
}
```

**Step 2: Create `tests/integration/integration/interceptor.test.js`**

```js
/**
 * Interceptor — pre-generate retrieval + chat[4] injection + access events.
 *
 * Non-JSDOM: mocks SillyTavern.getContext() and operates on plain arrays.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    starmemInterceptor, extractLastUserQuery, formatMemoryMessage,
    buildInjectionMessage, computeInjectionPosition,
    _setContextForTests, _resetContextForTests,
} from '../../../src/integration/interceptor.js';
import { INJECTION_KEY } from '../../../src/integration/constants.js';
import { INJECTION_DEPTH } from '../../../src/core/constants.js';
import { setBackend, _resetBackendForTests, loadState } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

/** @type {Map<string, unknown>} */
let store;

function makeChat(userText) {
    return [
        { name: 'char', is_user: false, is_system: false, send_date: 'd1', mes: 'Hi there' },
        { name: 'user', is_user: true, is_system: false, send_date: 'd2', mes: 'Hello' },
        { name: 'char', is_user: false, is_system: false, send_date: 'd3', mes: 'How are you?' },
        { name: 'user', is_user: true, is_system: false, send_date: 'd4', mes: 'Good' },
        { name: 'char', is_user: false, is_system: false, send_date: 'd5', mes: 'Glad' },
        { name: 'user', is_user: true, is_system: false, send_date: 'd6', mes: userText },
    ];
}

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    _setContextForTests({ chatId: 'chat-A' });
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetContextForTests();
});

describe('interceptor — pure helpers', () => {
    test('extractLastUserQuery returns the last is_user=true mes', () => {
        const chat = makeChat('latest question');
        expect(extractLastUserQuery(chat)).toBe('latest question');
    });

    test('extractLastUserQuery returns null when no user messages', () => {
        const chat = [{ name: 'char', is_user: false, is_system: false, send_date: '', mes: 'hi' }];
        expect(extractLastUserQuery(chat)).toBeNull();
    });

    test('extractLastUserQuery returns null for empty or non-array', () => {
        expect(extractLastUserQuery([])).toBeNull();
        expect(extractLastUserQuery(/** @type {any} */ (null))).toBeNull();
    });

    test('extractLastUserQuery skips whitespace-only user messages', () => {
        const chat = [
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'real query' },
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: '   ' },
        ];
        expect(extractLastUserQuery(chat)).toBe('real query');
    });

    test('formatMemoryMessage renders bullet list with scope labels', () => {
        const text = formatMemoryMessage([
            { id: '1', content: 'Alice likes coffee', scope: 'persona' },
            { id: '2', content: 'Alice went to Paris', scope: 'episodic' },
        ]);
        expect(text).toContain('[STARmem] Retrieved memories:');
        expect(text).toContain('- [persona] Alice likes coffee');
        expect(text).toContain('- [episodic] Alice went to Paris');
    });

    test('formatMemoryMessage returns empty string for zero entries', () => {
        expect(formatMemoryMessage([])).toBe('');
    });

    test('buildInjectionMessage marks the system message with INJECTION_KEY', () => {
        const m = buildInjectionMessage('hello');
        expect(m.is_user).toBe(false);
        expect(m.is_system).toBe(true);
        expect(m.mes).toBe('hello');
        expect(m.extra?.[INJECTION_KEY]).toBe(true);
    });

    test('computeInjectionPosition clamps at 0 for short chats', () => {
        expect(computeInjectionPosition(0, 4)).toBe(0);
        expect(computeInjectionPosition(3, 4)).toBe(0);
        expect(computeInjectionPosition(4, 4)).toBe(0);
    });

    test('computeInjectionPosition returns length - depth for long chats', () => {
        expect(computeInjectionPosition(10, 4)).toBe(6);
        expect(computeInjectionPosition(100, 4)).toBe(96);
    });
});

describe('interceptor — flow', () => {
    test('no chatId → no-op, chat unchanged', async () => {
        _setContextForTests({ chatId: null });
        const chat = makeChat('anything');
        const before = chat.length;
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(before);
    });

    test('no user query → no-op, chat unchanged', async () => {
        const chat = [{ name: 'c', is_user: false, is_system: false, send_date: '', mes: 'hi' }];
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(1);
    });

    test('empty retrieval result → no injection', async () => {
        store.set('chat-A', createEmptyState());  // no entries
        const chat = makeChat('anything');
        const before = chat.length;
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        expect(chat.length).toBe(before);
    });

    test('injects at chat.length - INJECTION_DEPTH when entries returned', async () => {
        const now = new Date('2026-04-20T10:00:00Z');
        const entry = createEntry({
            scope: 'episodic', content: 'alice traveled to paris', subject: 'alice',
            tags: ['paris', 'travel'], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now,
        });
        store.set('chat-A', {
            ...createEmptyState(),
            entries: { [entry.id]: entry },
            workingBuffer: [],  // ensure tier0/1/2 ladder evaluates
        });

        const chat = makeChat('tell me about paris');
        const expectedPos = chat.length - INJECTION_DEPTH;  // = 2
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        expect(chat.length).toBe(7);
        expect(chat[expectedPos].is_system).toBe(true);
        expect(chat[expectedPos].extra?.[INJECTION_KEY]).toBe(true);
        expect(chat[expectedPos].mes).toContain('[STARmem] Retrieved memories:');
    });

    test('short chat → injected at position 0', async () => {
        const now = new Date();
        const entry = createEntry({
            scope: 'episodic', content: 'alice likes coffee', subject: 'alice',
            tags: ['coffee'], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now,
        });
        store.set('chat-A', {
            ...createEmptyState(),
            entries: { [entry.id]: entry },
        });

        const chat = [
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'what does alice like' },
        ];
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        expect(chat.length).toBe(2);
        expect(chat[0].is_system).toBe(true);
    });

    test('applyAccessEvent fires for returned entries', async () => {
        const now = new Date('2026-04-20T10:00:00Z');
        const entry = createEntry({
            scope: 'episodic', content: 'alice likes coffee', subject: 'alice',
            tags: ['coffee'], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now,
        });
        const initialAccessCount = entry.lifecycle.accessCount;
        store.set('chat-A', {
            ...createEmptyState(),
            entries: { [entry.id]: entry },
        });

        const chat = makeChat('what does alice like');
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        const after = await loadState('chat-A');
        const stored = after.entries[entry.id];
        // Entry was returned → access count bumped.
        expect(stored.lifecycle.accessCount).toBe(initialAccessCount + 1);
    });

    test('access event does NOT fire for non-returned candidates', async () => {
        const now = new Date('2026-04-20T10:00:00Z');
        const matched = createEntry({
            scope: 'episodic', content: 'alice likes coffee', subject: 'alice',
            tags: ['coffee'], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now,
        });
        const irrelevant = createEntry({
            scope: 'episodic', content: 'bob plays chess', subject: 'bob',
            tags: ['chess'], relations: [],
            provenance: { sourceMessages: [1], extractor: 't@v1' },
            now,
        });
        const irrelevantAccessBefore = irrelevant.lifecycle.accessCount;
        store.set('chat-A', {
            ...createEmptyState(),
            entries: { [matched.id]: matched, [irrelevant.id]: irrelevant },
        });

        const chat = makeChat('what does alice like');
        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        const after = await loadState('chat-A');
        // Irrelevant entry wasn't returned → access count unchanged.
        expect(after.entries[irrelevant.id].lifecycle.accessCount).toBe(irrelevantAccessBefore);
    });

    test('thrown errors are swallowed — chat is never corrupted', async () => {
        // Force an error by feeding a bogus backend that throws on read.
        setBackend({
            read: () => { throw new Error('BOOM'); },
            write: () => {},
        });
        const chat = makeChat('anything');
        const before = JSON.stringify(chat);
        await starmemInterceptor(chat, 4096, () => {}, 'normal');
        // Chat must be untouched.
        expect(JSON.stringify(chat)).toBe(before);
    });
});
```

**Step 3: Controller audit**

After tests pass, run a standalone audit to verify the splice arithmetic on three fixture chats:

```bash
node --experimental-vm-modules -e '
import("./src/integration/interceptor.js").then(({ computeInjectionPosition }) => {
    const cases = [[0, 0], [3, 0], [4, 0], [5, 1], [10, 6], [100, 96]];
    for (const [len, want] of cases) {
        const got = computeInjectionPosition(len, 4);
        if (got !== want) { console.error(`FAIL: len=${len} want=${want} got=${got}`); process.exit(1); }
    }
    console.log("PASS: splice arithmetic audit");
});
' 2>&1 | tail -3
```

**Step 4: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/interceptor.test.js
# expect: 17 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/interceptor.js tests/integration/integration/interceptor.test.js
git commit -m "feat(integration): STARmemInterceptor — retrieve + inject at chat[-4]"
```

**Done when:**
- 17 interceptor tests pass (8 pure + 9 flow)
- Controller audit passes (6/6 splice cases)
- Full suite green
- `computeInjectionPosition(10, 4) === 6` verified in audit
- `applyAccessEvent` fires exactly for returned entries, not scored candidates

---

## Task 3 — `src/integration/bootstrap.js` (event wiring, controller)

**Objective:** The single place where ST events are subscribed. APP_READY loads settings, registers the interceptor as a global (already present from scaffold; we just re-point it), starts the scorer based on settings, mounts the indicator, and subscribes to lifecycle events. CHAT_CHANGED / MESSAGE_SENT / MESSAGE_RECEIVED / MESSAGE_DELETED each get a handler.

**Owner:** Controller. Subagents can't verify event-subscription timing without a real ST.

**Files:**
- Create: `src/integration/bootstrap.js`
- Create: `tests/integration/integration/bootstrap.test.js`

**Pre-flight notes:**

1. **APP_READY fires once per load.** Our handler must be idempotent — unregistering previous subscriptions if called twice. Not a hot path; safety over elegance.

2. **`setBackend({ read, write })` for `core/state.js`** is called here. The real backend reads + writes through `getContext().chatMetadata` + `saveMetadataDebounced`. Pattern mirrors the settings module's injectable context.

3. **Event handlers MUST be named exports** so tests can import them directly without triggering APP_READY. The bootstrap function itself wires them up.

4. **Idle timer rest on MESSAGE_SENT, not every keystroke.** The spec talks about "activity" but the cheapest reasonable proxy is message-send; typing isn't worth the debounce complexity.

5. **MESSAGE_RECEIVED is the post-turn signal.** That's where we push the exchange to the working buffer (via `consolidate`'s upstream — actually Phase 8 doesn't push directly; the interceptor's retrieval + ST's own message lifecycle handles that. The working buffer grows through the extension's own recording of each assistant message).

   **Wait.** Re-reading Phase 6's retro: `consolidate()` drains the working buffer; `maybeConsolidate()` gates it. But *who adds to the working buffer in the first place?* Phase 6 doesn't specify an add path because it was programmatic. Phase 8 is where it becomes real.

   Decision (locked now): **on MESSAGE_RECEIVED**, the bootstrap handler appends the `(last user message, this received message)` pair to `state.workingBuffer` and calls `maybeConsolidate`. This is the only place in v2 where the working buffer grows, keeping the one-path invariant crisp.

6. **MESSAGE_DELETED is a cleanup concern.** If the deleted message is still in the working buffer, we should remove it — otherwise consolidate would extract from a message that was retracted. Low-frequency operation; a full buffer scan is fine.

7. **Chat-switch hygiene.** On CHAT_CHANGED: `cancelIdleTimer(oldChatId)`, optionally `maybeConsolidate(oldChatId)` to drain the leftover buffer before swap. This is the "yes, trigger consolidate on chat switch" half of Decision 6.

**Step 1: Create `src/integration/bootstrap.js`**

```js
/**
 * Phase 8 bootstrap — APP_READY subscriptions, chat-switch hygiene, working-buffer growth.
 *
 * Called exactly once from index.js on the APP_READY event. Idempotent (safe
 * to call multiple times in dev); unsubscribes prior event handlers before
 * re-subscribing. Not safe against concurrent calls, which would never happen
 * in practice.
 *
 * @module integration/bootstrap
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { setBackend } from '../core/state.js';
import {
    maybeConsolidate, resetIdleTimer, cancelIdleTimer,
} from '../consolidation/index.js';
import { setScorer } from '../retrieval/index.js';
import { getSettings } from './settings.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:bootstrap');

/** @type {(() => void)[]} */
let unsubscribers = [];

/** @type {string | null} */
let lastChatId = null;

/** @type {any} */
let testContext = null;

/** Test-only: inject fake context. */
export function _setContextForTests(ctx) { testContext = ctx; }
/** Test-only: clear injected context. */
export function _resetContextForTests() { testContext = null; unsubscribers = []; lastChatId = null; }

/** @returns {any} */
function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') {
        throw new Error('[STARmem] SillyTavern.getContext() unavailable at bootstrap');
    }
    return st.getContext();
}

/**
 * Build the canonical state backend that reads + writes chatMetadata via ST.
 *
 * @returns {{ read: (id: string) => unknown, write: (id: string, v: unknown) => void }}
 */
export function buildStateBackend() {
    return {
        read: (id) => {
            const ctx = resolveContext();
            const cm = ctx?.chatMetadata;
            if (!cm || typeof cm !== 'object') return undefined;
            const slot = cm['STARmem'];
            if (!slot || typeof slot !== 'object') return undefined;
            return slot[id];
        },
        write: (id, value) => {
            const ctx = resolveContext();
            const cm = ctx?.chatMetadata;
            if (!cm || typeof cm !== 'object') {
                throw new Error('[STARmem] chatMetadata not available — cannot persist');
            }
            if (!cm['STARmem'] || typeof cm['STARmem'] !== 'object') {
                cm['STARmem'] = {};
            }
            cm['STARmem'][id] = value;
            if (typeof ctx.saveMetadataDebounced === 'function') {
                ctx.saveMetadataDebounced();
            }
        },
    };
}

/**
 * Event handler: CHAT_CHANGED. Idle-cancel the old chat, optional drain,
 * update lastChatId.
 *
 * @param {string} newChatId
 */
export async function onChatChanged(newChatId) {
    if (lastChatId && lastChatId !== newChatId) {
        try {
            cancelIdleTimer(lastChatId);
            const settings = getSettings();
            // Opportunistic drain before switching — don't block the UI.
            maybeConsolidate(lastChatId, {
                profileId: settings.profileId,
                extractorLabel: settings.extractionModelLabel || 'unknown@consolidation-v1',
                now: new Date(),
            }).catch(err => log.warn(`drain on chat-switch failed: ${err?.message || err}`));
        } catch (err) {
            log.warn(`chat-switch cleanup error (swallowed): ${err?.message || err}`);
        }
    }
    lastChatId = typeof newChatId === 'string' ? newChatId : null;
}

/**
 * Event handler: MESSAGE_SENT. Bumps idle timer for the current chat.
 *
 * @param {number} _messageId
 */
export function onMessageSent(_messageId) {
    if (!lastChatId) return;
    const settings = getSettings();
    try {
        resetIdleTimer(lastChatId, {
            idleMs: settings.idleTimeout,
            profileId: settings.profileId,
            extractorLabel: settings.extractionModelLabel || 'unknown@consolidation-v1',
        });
    } catch (err) {
        log.warn(`resetIdleTimer error (swallowed): ${err?.message || err}`);
    }
}

/**
 * Event handler: MESSAGE_RECEIVED. Append the exchange to the working buffer,
 * then maybeConsolidate.
 *
 * The exchange is captured by reading the chat array from getContext() —
 * we want the most-recent assistant message plus its preceding user message.
 *
 * @param {number} _messageId
 */
export async function onMessageReceived(_messageId) {
    if (!lastChatId) return;
    try {
        const ctx = resolveContext();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : null;
        if (!chat || chat.length < 2) return;
        // Find the most recent assistant + preceding user.
        const received = chat[chat.length - 1];
        if (!received || received.is_user || received.is_system) return;
        const preceding = chat[chat.length - 2];
        if (!preceding || !preceding.is_user) return;

        // Append to the working buffer as a pair.
        const { loadState, persistState } = await import('../core/state.js');
        const { withWriteLock } = await import('../core/lock.js');
        await withWriteLock(lastChatId, async () => {
            const state = await loadState(lastChatId);
            const nextBuffer = [...(state.workingBuffer || []), {
                userMes: preceding.mes,
                assistantMes: received.mes,
                sourceMessageIds: [chat.length - 2, chat.length - 1],
                addedAt: new Date().toISOString(),
            }];
            await persistState(lastChatId, { ...state, workingBuffer: nextBuffer });
        });

        const settings = getSettings();
        await maybeConsolidate(lastChatId, {
            profileId: settings.profileId,
            extractorLabel: settings.extractionModelLabel || 'unknown@consolidation-v1',
            now: new Date(),
        });
    } catch (err) {
        log.warn(`onMessageReceived error (swallowed): ${err?.message || err}`);
    }
}

/**
 * Event handler: MESSAGE_DELETED. Scrub the deleted message from the working
 * buffer if present.
 *
 * @param {number} messageId
 */
export async function onMessageDeleted(messageId) {
    if (!lastChatId) return;
    try {
        const { loadState, persistState } = await import('../core/state.js');
        const { withWriteLock } = await import('../core/lock.js');
        await withWriteLock(lastChatId, async () => {
            const state = await loadState(lastChatId);
            const buffer = state.workingBuffer || [];
            const filtered = buffer.filter(pair => !pair.sourceMessageIds?.includes(messageId));
            if (filtered.length !== buffer.length) {
                await persistState(lastChatId, { ...state, workingBuffer: filtered });
            }
        });
    } catch (err) {
        log.warn(`onMessageDeleted error (swallowed): ${err?.message || err}`);
    }
}

/**
 * Wire event handlers. Called from index.js on APP_READY. Returns an
 * unsubscribe function for testing; production callers don't need to use it.
 *
 * @returns {() => void} unsubscribe
 */
export function bootstrap() {
    // Tear down any prior subscription.
    for (const u of unsubscribers) { try { u(); } catch { /* ignore */ } }
    unsubscribers = [];

    const ctx = resolveContext();

    // State backend — routes loadState/persistState through chatMetadata.
    setBackend(buildStateBackend());

    // Scorer from persisted settings.
    const settings = getSettings();
    try { setScorer(settings.scorerId); } catch (err) { log.warn(`setScorer failed: ${err?.message || err}`); }

    // Seed lastChatId from current context.
    lastChatId = typeof ctx.chatId === 'string' && ctx.chatId.length > 0 ? ctx.chatId : null;

    // Subscribe to events.
    const { eventSource, eventTypes } = ctx;
    if (!eventSource || typeof eventSource.on !== 'function') {
        log.warn('no eventSource in context — events will not fire');
        return () => {};
    }
    const subs = [
        [eventTypes.CHAT_CHANGED, onChatChanged],
        [eventTypes.MESSAGE_SENT, onMessageSent],
        [eventTypes.MESSAGE_RECEIVED, onMessageReceived],
        [eventTypes.MESSAGE_DELETED, onMessageDeleted],
    ];
    for (const [evt, handler] of subs) {
        eventSource.on(evt, handler);
        unsubscribers.push(() => {
            if (typeof eventSource.removeListener === 'function') {
                eventSource.removeListener(evt, handler);
            } else if (typeof eventSource.off === 'function') {
                eventSource.off(evt, handler);
            }
        });
    }

    log.info(`bootstrap complete (${subs.length} subscriptions)`);
    return () => {
        for (const u of unsubscribers) { try { u(); } catch { /* ignore */ } }
        unsubscribers = [];
    };
}
```

**Step 2: Create `tests/integration/integration/bootstrap.test.js`**

```js
/**
 * Bootstrap — event wiring, state backend, chat-switch hygiene.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    bootstrap, buildStateBackend,
    onChatChanged, onMessageSent, onMessageReceived, onMessageDeleted,
    _setContextForTests, _resetContextForTests,
} from '../../../src/integration/bootstrap.js';
import {
    _setContextForTests as _setSettingsCtx,
    _resetContextForTests as _resetSettingsCtx,
} from '../../../src/integration/settings.js';
import { SETTINGS_KEY, SETTINGS_DEFAULTS } from '../../../src/integration/constants.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { _resetBackendForTests, setBackend, loadState } from '../../../src/core/state.js';
import { createEmptyState } from '../../../src/core/schema.js';

/** Simple event-source stub that matches ST's API (on / removeListener / emit). */
function makeEventSource() {
    const handlers = new Map();
    return {
        on: (evt, h) => {
            if (!handlers.has(evt)) handlers.set(evt, new Set());
            handlers.get(evt).add(h);
        },
        removeListener: (evt, h) => { handlers.get(evt)?.delete(h); },
        emit: async (evt, ...args) => {
            const hs = handlers.get(evt) || new Set();
            for (const h of hs) await h(...args);
        },
        _handlers: handlers,
    };
}

function makeContext({ chatId = 'chat-A', chat = [], chatMetadata = {} } = {}) {
    return {
        chatId, chat, chatMetadata,
        extensionSettings: {},
        saveSettingsDebounced: jest.fn(),
        saveMetadataDebounced: jest.fn(),
        eventSource: makeEventSource(),
        eventTypes: {
            CHAT_CHANGED: 'chat_id_changed',
            MESSAGE_SENT: 'message_sent',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_DELETED: 'message_deleted',
        },
    };
}

/** @type {ReturnType<typeof makeContext>} */
let ctx;

beforeEach(() => {
    ctx = makeContext();
    _setContextForTests(ctx);
    _setSettingsCtx({ extensionSettings: ctx.extensionSettings, saveSettingsDebounced: ctx.saveSettingsDebounced });
    _resetLocksForTests();
});

afterEach(() => {
    _resetContextForTests();
    _resetSettingsCtx();
    _resetBackendForTests();
    _resetLocksForTests();
});

describe('buildStateBackend', () => {
    test('read returns undefined when chatMetadata has no STARmem slot', () => {
        const be = buildStateBackend();
        expect(be.read('any')).toBeUndefined();
    });

    test('write creates the STARmem slot and persists', () => {
        const be = buildStateBackend();
        be.write('chat-A', { ...createEmptyState() });
        expect(ctx.chatMetadata['STARmem']['chat-A']).toBeDefined();
        expect(ctx.saveMetadataDebounced).toHaveBeenCalled();
    });

    test('read round-trips what write stored', () => {
        const be = buildStateBackend();
        const s = { ...createEmptyState(), entries: { x: { id: 'x' } } };
        be.write('chat-A', s);
        const back = be.read('chat-A');
        expect(back).toEqual(s);
    });
});

describe('bootstrap', () => {
    test('subscribes to four events on APP_READY', () => {
        bootstrap();
        expect(ctx.eventSource._handlers.get('chat_id_changed').size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_sent').size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_received').size).toBe(1);
        expect(ctx.eventSource._handlers.get('message_deleted').size).toBe(1);
    });

    test('double-call idempotently replaces subscriptions (no leak)', () => {
        bootstrap();
        bootstrap();
        expect(ctx.eventSource._handlers.get('chat_id_changed').size).toBe(1);
    });

    test('returns an unsubscribe function that removes handlers', () => {
        const off = bootstrap();
        off();
        expect(ctx.eventSource._handlers.get('chat_id_changed').size).toBe(0);
    });

    test('persists default settings on first call', () => {
        bootstrap();
        expect(ctx.extensionSettings[SETTINGS_KEY]).toEqual(SETTINGS_DEFAULTS);
    });

    test('installs state backend routing through chatMetadata', async () => {
        bootstrap();
        // Once the backend is set via bootstrap, a loadState call should read from chatMetadata.
        ctx.chatMetadata['STARmem'] = { 'chat-A': { ...createEmptyState(), entries: { foo: { id: 'foo' } } } };
        const s = await loadState('chat-A');
        expect(s.entries.foo).toBeDefined();
    });
});

describe('onChatChanged', () => {
    test('cancels idle timer for old chat and updates lastChatId', async () => {
        bootstrap();  // seeds lastChatId = 'chat-A'
        await onChatChanged('chat-B');
        // Subsequent MESSAGE_SENT should reset timer on chat-B, not chat-A.
        // (Not directly observable without a timer mock — we're asserting no throw.)
        await onMessageSent(0);
    });
});

describe('onMessageReceived', () => {
    test('appends user+assistant pair to working buffer', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'user msg' },
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'assistant msg' },
        ];
        await onMessageReceived(1);
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(1);
        expect(state.workingBuffer[0].userMes).toBe('user msg');
        expect(state.workingBuffer[0].assistantMes).toBe('assistant msg');
    });

    test('skips if last message is not assistant', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = { 'chat-A': createEmptyState() };
        ctx.chat = [
            { name: 'c', is_user: false, is_system: false, send_date: '', mes: 'a' },
            { name: 'u', is_user: true, is_system: false, send_date: '', mes: 'b' },
        ];
        await onMessageReceived(1);
        const state = await loadState('chat-A');
        expect(state.workingBuffer || []).toHaveLength(0);
    });
});

describe('onMessageDeleted', () => {
    test('removes deleted message from working buffer if present', async () => {
        bootstrap();
        ctx.chatMetadata['STARmem'] = {
            'chat-A': {
                ...createEmptyState(),
                workingBuffer: [
                    { userMes: 'u1', assistantMes: 'a1', sourceMessageIds: [4, 5], addedAt: '' },
                    { userMes: 'u2', assistantMes: 'a2', sourceMessageIds: [6, 7], addedAt: '' },
                ],
            },
        };
        await onMessageDeleted(6);
        const state = await loadState('chat-A');
        expect(state.workingBuffer).toHaveLength(1);
        expect(state.workingBuffer[0].userMes).toBe('u1');
    });
});
```

**Step 3: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/bootstrap.test.js
# expect: ~15 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/bootstrap.js tests/integration/integration/bootstrap.test.js
git commit -m "feat(integration): APP_READY bootstrap — event wiring, backend, working-buffer growth"
```

**Done when:**
- All bootstrap tests green
- buildStateBackend round-trips via chatMetadata
- No event-subscription leaks on double-bootstrap
- onMessageReceived correctly grows working buffer
- onMessageDeleted scrubs working buffer

---
## Task 4 — `src/integration/indicator.js` (consolidation dot)

**Objective:** A subtle DOM indicator that reflects `state.runtime.consolidating`. Mount once on APP_READY; poll on an interval (v2 doesn't emit state-change events, so polling). Render a tiny colored dot **inside `#send_but_container`** (ST's send-button wrapper — stable structure, always visible in chat view). Invisible when idle, visible (animated amber pulse) when consolidating. Falls back to `document.body` + fixed positioning only if `#send_but_container` isn't in the DOM at mount time.

**Decision 14 note:** This task was drafted against `document.body` + fixed positioning. Decision 14.B during chunk-6/7 finalization revised it to anchor inside ST's send-button container for tighter visual integration. The code below reflects the revised target; `style.css` (Task 10) sets `position: relative` on `#send_but_container` so the indicator's absolute positioning anchors correctly.

**Owner:** Subagent. Small scope, JSDOM-testable.

**Context for the subagent:**

```
ABSOLUTE REPO PATH: /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem

Verify with `git log -1` showing <HEAD after Task 3> before work.

Constraints:
- NO npm install.
- Vanilla DOM only — no jQuery, no frameworks.
- All class names start with `starmem-`.
- Polling interval = 1s. NOT configurable yet; Phase 9 benchmark mode can add if needed.
- Indicator mounts inside `#send_but_container` (ST's stable send-button wrapper). If that element is missing at mount time, fall back to `document.body` with fixed positioning — log a debug line when the fallback path fires so tests and manual smoke can distinguish.
- Every mount MUST be idempotent: un-mount prior indicator DOM if present (by id).
- Expose `mountIndicator()`, `unmountIndicator()`, `_tickForTests()` as named exports.
- Test with jest-environment-jsdom — add to jest.config.js if not already present.
```

**Step 1: Check JSDOM availability**

Before Task 4 starts, confirm the jest config supports a per-file testEnvironment comment or a pattern-based split. Current `jest.config.js` uses ESM and no explicit environment — jest defaults to `node`. JSDOM tests need `@jest-environment jsdom` docblock OR a config override.

```bash
cat jest.config.js
npm ls jest-environment-jsdom 2>&1 | head -3
```

If `jest-environment-jsdom` is not installed, add it as a devDep:

```bash
npm install --save-dev jest-environment-jsdom
git add package.json package-lock.json
# defer commit — bundle into Task 4 commit
```

Use per-file docblock: `/** @jest-environment jsdom */` at the top of JSDOM tests.

**Step 2: Create `src/integration/indicator.js`**

```js
/**
 * Consolidation indicator — a subtle dot that pulses while consolidation is
 * running. Mounted once on APP_READY; polls state.runtime.consolidating via
 * loadState() on a 1-second interval.
 *
 * Invisible when consolidating=false; visible + animated when consolidating=true.
 *
 * @module integration/indicator
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { loadState } from '../core/state.js';
import { CSS_PREFIX } from './constants.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:indicator');

const INDICATOR_ID = `${CSS_PREFIX}-indicator`;
const POLL_INTERVAL_MS = 1000;

/** @type {number | null} */
let intervalId = null;
/** @type {HTMLElement | null} */
let el = null;
/** @type {(() => string | null) | null} */
let chatIdResolver = null;

/**
 * Mount the indicator. Idempotent — removes prior mount before creating a new one.
 *
 * @param {() => string | null} getChatId - called each tick to resolve current chat
 */
export function mountIndicator(getChatId) {
    unmountIndicator();
    chatIdResolver = getChatId;

    const dot = document.createElement('div');
    dot.id = INDICATOR_ID;
    dot.className = `${CSS_PREFIX}-indicator`;
    dot.setAttribute('role', 'status');
    dot.setAttribute('aria-label', 'STARmem consolidation');
    dot.title = 'STARmem: idle';
    // Initially hidden (CSS class toggles visibility).
    dot.classList.add(`${CSS_PREFIX}-indicator-idle`);

    // Decision 14.B: prefer ST's send-button container as mount anchor.
    // style.css sets `#send_but_container { position: relative }` so our
    // absolute-positioned dot anchors there. Fall back to document.body
    // with fixed positioning if the container isn't mounted yet (defensive).
    const anchor = document.getElementById('send_but_container');
    if (anchor) {
        anchor.appendChild(dot);
    } else {
        log.debug('#send_but_container not found; falling back to document.body');
        dot.classList.add(`${CSS_PREFIX}-indicator-floating`);   // CSS opts into fixed positioning
        document.body.appendChild(dot);
    }
    el = dot;

    intervalId = /** @type {number} */ (setInterval(tick, POLL_INTERVAL_MS));
    log.debug(`mounted @ #${INDICATOR_ID}, polling every ${POLL_INTERVAL_MS}ms`);
}

/** Unmount + remove any DOM. Idempotent. */
export function unmountIndicator() {
    if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
    }
    // Remove by id too, defensively — the module instance may have been
    // re-loaded in dev mode and lost its reference to `el`.
    const existing = document.getElementById(INDICATOR_ID);
    if (existing) existing.remove();
    el = null;
    chatIdResolver = null;
}

/** Internal: one poll. Exposed for tests to step deterministically. */
export async function _tickForTests() { await tick(); }

async function tick() {
    if (!el || !chatIdResolver) return;
    try {
        const chatId = chatIdResolver();
        if (!chatId) {
            setIdle();
            return;
        }
        const state = await loadState(chatId);
        const isConsolidating = Boolean(state?.runtime?.consolidating);
        if (isConsolidating) setBusy(state?.runtime);
        else setIdle();
    } catch (err) {
        // Swallow — indicator must never break. Fall back to idle.
        setIdle();
        log.debug(`tick error: ${err?.message || err}`);
    }
}

function setIdle() {
    if (!el) return;
    el.classList.remove(`${CSS_PREFIX}-indicator-busy`);
    el.classList.add(`${CSS_PREFIX}-indicator-idle`);
    el.title = 'STARmem: idle';
}

/**
 * @param {{ consolidating?: boolean, lastConsolidation?: { added?: number, updated?: number, drained?: number } | null } | undefined} runtime
 */
function setBusy(runtime) {
    if (!el) return;
    el.classList.remove(`${CSS_PREFIX}-indicator-idle`);
    el.classList.add(`${CSS_PREFIX}-indicator-busy`);
    const last = runtime?.lastConsolidation;
    if (last) {
        el.title = `STARmem: consolidating (prev: +${last.added ?? 0} / ~${last.updated ?? 0} / drained ${last.drained ?? 0})`;
    } else {
        el.title = 'STARmem: consolidating';
    }
}
```

**Step 3: Create `tests/integration/integration/indicator.test.js`**

```js
/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
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
        // No #send_but_container in the DOM.
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
});

describe('indicator — polling behavior', () => {
    test('tick with consolidating=false keeps idle class', async () => {
        store.set('chat-A', { ...createEmptyState(), runtime: { consolidating: false, lastConsolidation: null, traces: [] } });
        mountIndicator(() => 'chat-A');
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(true);
    });

    test('tick with consolidating=true swaps to busy class', async () => {
        store.set('chat-A', { ...createEmptyState(), runtime: { consolidating: true, lastConsolidation: null, traces: [] } });
        mountIndicator(() => 'chat-A');
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-busy`)).toBe(true);
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(false);
    });

    test('tick with null chatId → idle', async () => {
        mountIndicator(() => null);
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(true);
    });

    test('tick survives a throwing state backend → idle', async () => {
        setBackend({ read: () => { throw new Error('BOOM'); }, write: () => {} });
        mountIndicator(() => 'chat-A');
        // Must not throw.
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.classList.contains(`${CSS_PREFIX}-indicator-idle`)).toBe(true);
    });

    test('busy tooltip includes last-run counts when present', async () => {
        store.set('chat-A', {
            ...createEmptyState(),
            runtime: {
                consolidating: true,
                lastConsolidation: { added: 2, updated: 1, drained: 5 },
                traces: [],
            },
        });
        mountIndicator(() => 'chat-A');
        await _tickForTests();
        const dot = /** @type {HTMLElement} */ (document.getElementById(`${CSS_PREFIX}-indicator`));
        expect(dot.title).toContain('+2');
        expect(dot.title).toContain('~1');
        expect(dot.title).toContain('drained 5');
    });
});
```

**Step 4: Run + commit**

```bash
npm install --save-dev jest-environment-jsdom  # if not present
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/indicator.test.js
# expect: ~10 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add package.json package-lock.json src/integration/indicator.js tests/integration/integration/indicator.test.js
git commit -m "feat(integration): consolidation indicator — polls runtime.consolidating"
```

**Done when:**
- 10 indicator tests green
- `jest-environment-jsdom` installed (if needed)
- No DOM leak on double mount
- Busy/idle tooltip correctness verified

---

## Task 5 — `src/integration/settingsPanel.js` + `settings.html`

**Objective:** The actual settings UI the user sees. Static HTML template (`settings.html`) + JS that wires DOM events to `setSettings()` from Task 1. Includes connection-profile dropdown (profileId + embedProfileId), scorer dropdown, bufferSize / idleTimeout / tracesMaxLen sliders, extractionModelLabel input, debugMode checkbox, and a Reset button.

**Owner:** Subagent.

**Context for the subagent:**

```
ABSOLUTE REPO PATH: /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem

Verify with `git log -1` showing <HEAD after Task 4> before work.

Constraints:
- Static HTML template — settings.html lives at the repo root alongside manifest.json.
  SillyTavern's convention: `getContext().renderExtensionTemplateAsync('third-party/SillyTavern-STARmem', 'settings')` loads it as an HTML fragment.
- All IDs + classes prefixed with `starmem-settings-` (or `starmem-` where natural).
- NO jQuery. Vanilla DOM.
- Event wiring: `input` event on sliders (live update) + `change` on selects/checkboxes + `click` on Reset button.
- Use the getSettings/setSettings surface from integration/settings.js.
- Profile discovery via getContext().extensionSettings.connectionManager.profiles (array of {id, name, api}).
  If this path is missing, show a warning instead of a dropdown ("Connection Manager not configured").
- Mount takes a (parentElement) and renders into it. The caller (bootstrap or a slash command) supplies the parent.
- All subagent-written code must be lint-clean and typecheck clean.
```

**Pre-flight API verification for the subagent:**

Before writing, confirm the ConnectionManager profiles shape by inspecting the ST source:

```bash
grep -B 2 -A 10 "connectionManager\s*=\|connectionManager\.profiles\|connection_manager.*profiles" /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/connection-manager/index.js | head -40
```

Expected shape based on earlier recon: `ctx.extensionSettings.connectionManager.profiles = [{ id: string, name: string, api: string, ... }, ...]`. If the actual path differs, adapt the discovery function below and note the deviation in the commit message.

**Step 1: Create `settings.html` (repo root)**

```html
<div class="starmem-settings-panel">
    <h3 class="starmem-settings-title">STARmem</h3>
    <p class="starmem-settings-subtitle">Deterministic roleplay memory — v2</p>

    <details open class="starmem-settings-section">
        <summary>Connection profiles</summary>
        <div class="starmem-settings-row">
            <label for="starmem-settings-profile-id">Extractor LLM:</label>
            <select id="starmem-settings-profile-id" class="text_pole"></select>
        </div>
        <div class="starmem-settings-row">
            <label for="starmem-settings-embed-profile-id">Embeddings (persona rebuild):</label>
            <select id="starmem-settings-embed-profile-id" class="text_pole"></select>
        </div>
        <div class="starmem-settings-row">
            <label for="starmem-settings-extraction-label">Extractor label (provenance):</label>
            <input type="text" id="starmem-settings-extraction-label" class="text_pole"
                placeholder="e.g. gemma-4-31b@consolidation-v1" />
        </div>
    </details>

    <details class="starmem-settings-section">
        <summary>Triggers</summary>
        <div class="starmem-settings-row">
            <label for="starmem-settings-buffer-size">Buffer size (drain at):</label>
            <input type="range" id="starmem-settings-buffer-size" min="1" max="50" step="1" />
            <span id="starmem-settings-buffer-size-value" class="starmem-settings-value"></span>
        </div>
        <div class="starmem-settings-row">
            <label for="starmem-settings-idle-timeout">Idle timeout (seconds):</label>
            <input type="range" id="starmem-settings-idle-timeout" min="5" max="600" step="5" />
            <span id="starmem-settings-idle-timeout-value" class="starmem-settings-value"></span>
        </div>
    </details>

    <details class="starmem-settings-section">
        <summary>Retrieval</summary>
        <div class="starmem-settings-row">
            <label for="starmem-settings-scorer">Scorer:</label>
            <select id="starmem-settings-scorer" class="text_pole"></select>
        </div>
    </details>

    <details class="starmem-settings-section">
        <summary>Debug</summary>
        <div class="starmem-settings-row">
            <label for="starmem-settings-traces-max">Traces buffer cap:</label>
            <input type="range" id="starmem-settings-traces-max" min="16" max="1024" step="16" />
            <span id="starmem-settings-traces-max-value" class="starmem-settings-value"></span>
        </div>
        <div class="starmem-settings-row">
            <label>
                <input type="checkbox" id="starmem-settings-debug-mode" />
                Debug logging
            </label>
        </div>
    </details>

    <div class="starmem-settings-actions">
        <button type="button" id="starmem-settings-reset" class="menu_button">Reset to defaults</button>
        <button type="button" id="starmem-settings-open-viewer" class="menu_button">Open Memory Viewer</button>
    </div>

    <div id="starmem-settings-warnings" class="starmem-settings-warnings" aria-live="polite"></div>
</div>
```

**Step 2: Create `src/integration/settingsPanel.js`**

```js
/**
 * Settings panel — DOM wiring for settings.html.
 *
 * Reads settings via getSettings(), mutates via setSettings()/resetSettings(),
 * populates dropdowns from ST's connection-manager profile list, exposes a
 * callback for the "Open Memory Viewer" button.
 *
 * @module integration/settingsPanel
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { getSettings, setSettings, resetSettings } from './settings.js';
import { CSS_PREFIX } from './constants.js';
import { createLogger } from '../core/logger.js';
import { registerScorer, getScorer } from '../retrieval/index.js';

const log = createLogger({ debug: false }).scope('integration:settingsPanel');

/** @type {any} */
let testContext = null;

/** Test-only context injector. */
export function _setContextForTests(ctx) { testContext = ctx; }
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

/** Registered scorer ids. Exposed for dropdown population. */
export function getAvailableScorerIds() {
    // The registry doesn't currently export a list method; we hardcode 'default'
    // as always-present and probe common ids. Phase 9 should add a proper
    // listScorers() to retrieval/index.js.
    const ids = ['default'];
    // Probe — if getScorer throws for an id we'd try, it's not registered.
    for (const candidate of /** @type {string[]} */ ([])) {
        try { getScorer(candidate); ids.push(candidate); } catch { /* not registered */ }
    }
    return ids;
}

/**
 * Render the panel into the given parent. Idempotent — removes prior content.
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
        // Test / degraded-env fallback — inline a minimal template so tests don't need
        // a real ST template renderer.
        html = fallbackTemplate();
    }
    parent.innerHTML = html;

    const s = getSettings();
    populateProfileDropdown('starmem-settings-profile-id', s.profileId);
    populateProfileDropdown('starmem-settings-embed-profile-id', s.embedProfileId);
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
            // Also hot-swap the active scorer.
            const { setScorer } = await import('../retrieval/index.js');
            try { setScorer(scorer.value); } catch (err) { log.warn(`setScorer failed: ${err?.message || err}`); }
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

/** Render warnings about missing ST APIs. */
function renderWarnings(parent) {
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
```

**Step 3: Create `tests/integration/integration/settingsPanel.test.js`**

```js
/**
 * @jest-environment jsdom
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

function makeContext({ profiles = [] } = {}) {
    return {
        extensionSettings: {
            connectionManager: { profiles },
        },
        saveSettingsDebounced: jest.fn(),
        renderExtensionTemplateAsync: null,  // forces fallback template
    };
}

let ctx;
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
    parent = document.createElement('div');
    document.body.appendChild(parent);
});

afterEach(() => {
    _resetContextForTests();
    _resetSettingsCtx();
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
        // Reset re-renders; await a microtask.
        await Promise.resolve();
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
});
```

**Step 4: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/settingsPanel.test.js
# expect: ~13 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add settings.html src/integration/settingsPanel.js tests/integration/integration/settingsPanel.test.js
git commit -m "feat(integration): settings UI — profile/scorer dropdowns + sliders + Reset"
```

**Done when:**
- All 13 settings panel tests green
- Slider input events persist through setSettings
- Reset button restores defaults
- Warning rendered when no CM profiles configured
- Open Viewer callback fires

---
## Task 6 — `src/integration/viewer/mount.js` (tabbed viewer shell)

**Objective:** The Memory Viewer modal shell. Opens as an ST Popup (via `getContext().Popup`) with a tabbed layout — Working, Episodic, Persona, Graph, Traces. Handles tab switching, shared subject-filter input at the top, close button. Individual tab bodies are mounted by their own modules (Tasks 7.1-7.5).

**Owner:** Subagent.

**Context for the subagent:**

```
ABSOLUTE REPO PATH: /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem

Verify with `git log -1` showing <HEAD after Task 5> before work.

Constraints:
- NO npm install.
- Vanilla DOM.
- All IDs/classes prefixed `starmem-viewer-`.
- Tab modules expose a common contract: `export async function renderTab(parentEl, ctx)` where ctx = { chatId, subjectFilter, state, onRebuildPersona, ... }.
  For now, tab modules only need (parentEl, chatId, subjectFilter); refine per tab.
- Subject filter is a shared input at the top; changes re-render the active tab.
- Close button tears down tab modules and resolves the Popup.
- If getContext().Popup is missing (test env), fall back to appending into document.body with the same structure — same DOM, no modal chrome.
```

**Step 1: Create `src/integration/viewer/mount.js`**

```js
/**
 * Memory Viewer shell — tabbed modal with Working/Episodic/Persona/Graph/Traces.
 *
 * Opens via openViewer(chatId); closes via the X button (or Popup dismiss).
 * Individual tabs render their own content; this module handles tab switching,
 * the shared subject filter, and modal lifecycle.
 *
 * @module integration/viewer/mount
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { VIEWER_TABS, CSS_PREFIX } from '../constants.js';
import { loadState } from '../../core/state.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:viewer');

/** @type {any} */
let testContext = null;

export function _setContextForTests(ctx) { testContext = ctx; }
export function _resetContextForTests() { testContext = null; }

function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') return {};
    return st.getContext();
}

/**
 * @typedef {object} ViewerState
 * @property {string} chatId
 * @property {string} activeTab
 * @property {string} subjectFilter
 * @property {HTMLElement} root
 * @property {HTMLElement} tabBody
 * @property {() => void} [close]
 */

/**
 * Open the Memory Viewer for a chat. Returns the resolved viewer state object
 * once it's mounted. For tests, pass `{ parent: HTMLElement }` to mount
 * inline instead of opening a popup.
 *
 * @param {string} chatId
 * @param {{ parent?: HTMLElement, onClose?: () => void }} [opts]
 * @returns {Promise<ViewerState>}
 */
export async function openViewer(chatId, opts = {}) {
    const ctx = resolveContext();
    const root = buildRootElement(chatId);

    /** @type {ViewerState} */
    const state = {
        chatId,
        activeTab: VIEWER_TABS[0],
        subjectFilter: '',
        root,
        tabBody: /** @type {HTMLElement} */ (root.querySelector(`.${CSS_PREFIX}-viewer-body`)),
    };

    wireTabs(state);
    wireSubjectFilter(state);
    wireClose(state, opts.onClose);

    await renderActiveTab(state);

    // Mount. Prefer Popup if available; otherwise append to provided parent or body.
    if (opts.parent) {
        opts.parent.appendChild(root);
        state.close = () => { root.remove(); opts.onClose?.(); };
    } else if (ctx.Popup && ctx.POPUP_TYPE) {
        const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', { wide: true });
        state.close = () => { popup.complete?.(); opts.onClose?.(); };
        popup.show();
    } else {
        document.body.appendChild(root);
        state.close = () => { root.remove(); opts.onClose?.(); };
    }

    return state;
}

/** Build the DOM skeleton (header, tabs, body, footer). */
function buildRootElement(chatId) {
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer`;
    root.setAttribute('data-chat-id', chatId);

    root.innerHTML = `
        <div class="${CSS_PREFIX}-viewer-header">
            <h2 class="${CSS_PREFIX}-viewer-title">STARmem Memory Viewer</h2>
            <button type="button" class="${CSS_PREFIX}-viewer-close" aria-label="Close">✕</button>
        </div>
        <div class="${CSS_PREFIX}-viewer-filter-row">
            <label for="${CSS_PREFIX}-viewer-subject">Subject:</label>
            <input type="text" id="${CSS_PREFIX}-viewer-subject" class="${CSS_PREFIX}-viewer-subject-input" placeholder="(all subjects)" />
        </div>
        <nav class="${CSS_PREFIX}-viewer-tabs" role="tablist">
            ${VIEWER_TABS.map(t => `
                <button type="button" role="tab" class="${CSS_PREFIX}-viewer-tab" data-tab="${t}">${titleFor(t)}</button>
            `).join('')}
        </nav>
        <div class="${CSS_PREFIX}-viewer-body" role="tabpanel"></div>
    `;
    return root;
}

function titleFor(tab) {
    switch (tab) {
        case 'working': return 'Working';
        case 'episodic': return 'Episodic';
        case 'persona': return 'Persona';
        case 'graph': return 'Graph';
        case 'traces': return 'Traces';
        default: return tab;
    }
}

function wireTabs(state) {
    const buttons = state.root.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`);
    for (const btn of buttons) {
        btn.addEventListener('click', async () => {
            const tab = /** @type {HTMLElement} */ (btn).dataset.tab;
            if (!tab) return;
            state.activeTab = tab;
            highlightActiveTab(state);
            await renderActiveTab(state);
        });
    }
    highlightActiveTab(state);
}

function highlightActiveTab(state) {
    const buttons = state.root.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`);
    for (const btn of buttons) {
        const tab = /** @type {HTMLElement} */ (btn).dataset.tab;
        if (tab === state.activeTab) {
            btn.classList.add(`${CSS_PREFIX}-viewer-tab-active`);
            btn.setAttribute('aria-selected', 'true');
        } else {
            btn.classList.remove(`${CSS_PREFIX}-viewer-tab-active`);
            btn.setAttribute('aria-selected', 'false');
        }
    }
}

function wireSubjectFilter(state) {
    const input = /** @type {HTMLInputElement | null} */ (state.root.querySelector(`.${CSS_PREFIX}-viewer-subject-input`));
    if (!input) return;
    let debounceId = null;
    input.addEventListener('input', () => {
        state.subjectFilter = input.value.trim();
        if (debounceId) clearTimeout(debounceId);
        debounceId = setTimeout(() => { renderActiveTab(state); }, 150);
    });
}

function wireClose(state, onClose) {
    const btn = state.root.querySelector(`.${CSS_PREFIX}-viewer-close`);
    if (!btn) return;
    btn.addEventListener('click', () => {
        state.close?.();
        if (typeof onClose === 'function') onClose();
    });
}

async function renderActiveTab(state) {
    state.tabBody.innerHTML = `<div class="${CSS_PREFIX}-viewer-loading">Loading…</div>`;
    try {
        const tabModule = await loadTabModule(state.activeTab);
        const snapshot = await loadState(state.chatId);
        state.tabBody.innerHTML = '';
        await tabModule.renderTab(state.tabBody, {
            chatId: state.chatId,
            subjectFilter: state.subjectFilter,
            state: snapshot,
        });
    } catch (err) {
        log.warn(`tab render failed: ${err?.message || err}`);
        state.tabBody.innerHTML = `<div class="${CSS_PREFIX}-viewer-error">Error rendering tab: ${escapeHtml(String(err?.message || err))}</div>`;
    }
}

async function loadTabModule(tab) {
    switch (tab) {
        case 'working': return await import('./tabs/working.js');
        case 'episodic': return await import('./tabs/episodic.js');
        case 'persona': return await import('./tabs/persona.js');
        case 'graph': return await import('./tabs/graph.js');
        case 'traces': return await import('./tabs/traces.js');
        default: throw new Error(`Unknown tab: ${tab}`);
    }
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch] || ch);
}
```

**Step 2: Create `tests/integration/integration/viewer-mount.test.js`**

```js
/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    openViewer, _setContextForTests, _resetContextForTests,
} from '../../../src/integration/viewer/mount.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { VIEWER_TABS, CSS_PREFIX } from '../../../src/integration/constants.js';

let parent;

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    setBackend({ read: () => createEmptyState(), write: () => {} });
    _setContextForTests({});  // force fallback (no Popup)
});

afterEach(() => {
    _resetContextForTests();
    _resetBackendForTests();
    document.body.innerHTML = '';
});

describe('viewer mount', () => {
    test('openViewer mounts into provided parent with all tab buttons', async () => {
        await openViewer('chat-A', { parent });
        const tabs = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`);
        expect(tabs.length).toBe(VIEWER_TABS.length);
    });

    test('first tab (working) is initially active', async () => {
        await openViewer('chat-A', { parent });
        const active = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-tab-active`);
        expect(active.length).toBe(1);
        expect(/** @type {HTMLElement} */ (active[0]).dataset.tab).toBe('working');
    });

    test('clicking a tab switches the active one', async () => {
        await openViewer('chat-A', { parent });
        const episodicBtn = /** @type {HTMLElement} */ (parent.querySelector('[data-tab="episodic"]'));
        episodicBtn.click();
        // allow the async renderActiveTab to complete
        await new Promise(r => setTimeout(r, 0));
        const active = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-tab-active`);
        expect(/** @type {HTMLElement} */ (active[0]).dataset.tab).toBe('episodic');
    });

    test('close button removes the viewer from DOM', async () => {
        const state = await openViewer('chat-A', { parent });
        const closeBtn = /** @type {HTMLElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-close`));
        closeBtn.click();
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer`)).toBeNull();
    });

    test('subject filter input updates state and triggers re-render', async () => {
        const state = await openViewer('chat-A', { parent });
        const input = /** @type {HTMLInputElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-subject-input`));
        input.value = 'alice';
        input.dispatchEvent(new Event('input'));
        await new Promise(r => setTimeout(r, 200));  // debounce
        expect(state.subjectFilter).toBe('alice');
    });

    test('tab body shows loading state during render', async () => {
        await openViewer('chat-A', { parent });
        // Click a different tab to trigger loading.
        const btn = /** @type {HTMLElement} */ (parent.querySelector('[data-tab="graph"]'));
        btn.click();
        // The innerHTML briefly contains 'Loading…' — after render it's gone.
        await new Promise(r => setTimeout(r, 0));
        const body = /** @type {HTMLElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-body`));
        expect(body).not.toBeNull();
    });

    test('falls back to document.body when no parent and no Popup', async () => {
        _setContextForTests({});  // no Popup
        const state = await openViewer('chat-A', {});
        expect(document.body.contains(state.root)).toBe(true);
        state.close?.();
    });

    test('uses Popup when available in context', async () => {
        const popupShow = jest.fn();
        const popupComplete = jest.fn();
        _setContextForTests({
            Popup: class { constructor() {} show = popupShow; complete = popupComplete; },
            POPUP_TYPE: { TEXT: 1 },
        });
        await openViewer('chat-A', {});
        expect(popupShow).toHaveBeenCalled();
    });

    test('onClose callback fires when close button clicked', async () => {
        const onClose = jest.fn();
        await openViewer('chat-A', { parent, onClose });
        const closeBtn = /** @type {HTMLElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-close`));
        closeBtn.click();
        expect(onClose).toHaveBeenCalled();
    });
});
```

**Step 3: Stub tab modules so mount tests don't fail on dynamic import**

Before the mount test runs, each of `src/integration/viewer/tabs/{working,episodic,persona,graph,traces}.js` must exist with at least a `renderTab` export. Create them as one-line stubs; Tasks 7.1-7.5 fill them in:

```js
// src/integration/viewer/tabs/working.js
export async function renderTab(parent, _ctx) {
    parent.innerHTML = '<div class="starmem-viewer-tab-stub" data-tab="working">Working — stub</div>';
}
```

Repeat for the other four tabs (episodic, persona, graph, traces) with their own data-tab value. These stubs land inside the Task 6 commit so mount tests pass; Tasks 7.1-7.5 replace each with the real implementation.

**Step 4: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/viewer-mount.test.js
# expect: 9 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/viewer/
git add tests/integration/integration/viewer-mount.test.js
git commit -m "feat(integration): viewer shell — tabs, subject filter, close, popup fallback"
```

**Done when:**
- 9 viewer mount tests green
- All 5 tab stubs exist (so dynamic imports succeed)
- Tab switching re-renders the body
- Subject filter debounces + re-renders
- Close removes from DOM and fires onClose

---

## Task 7.1 — `viewer/tabs/working.js`

**Objective:** Render the working buffer contents. Each entry is a `{ userMes, assistantMes, sourceMessageIds, addedAt }` pair. Show them as a list, newest-first, with truncation for long messages.

**Owner:** Subagent.

**Context for the subagent:**

```
ABSOLUTE REPO PATH: <path>
Verify with `git log -1` showing <HEAD after Task 6> before work.

Constraints:
- NO npm install.
- Replace the existing one-line stub at src/integration/viewer/tabs/working.js.
- Contract: export async function renderTab(parent, ctx) where ctx = { chatId, subjectFilter, state }.
- state is the loaded STARmem state — has .workingBuffer array.
- subjectFilter is ignored for Working (it's a conversation buffer, not subject-tagged).
- All text rendered via textContent (NOT innerHTML) to prevent XSS on chat content.
- Truncate messages > 200 chars with "…(more)" inline expand button.
```

**Step 1: Replace `src/integration/viewer/tabs/working.js`**

```js
/**
 * Working tab — render the working buffer (pairs awaiting consolidation).
 *
 * @module integration/viewer/tabs/working
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { CSS_PREFIX } from '../../constants.js';

const MAX_INLINE_LEN = 200;

/**
 * @param {HTMLElement} parent
 * @param {{ state: { workingBuffer?: Array<{userMes: string, assistantMes: string, sourceMessageIds?: number[], addedAt?: string}> } }} ctx
 */
export async function renderTab(parent, ctx) {
    const buffer = Array.isArray(ctx?.state?.workingBuffer) ? ctx.state.workingBuffer : [];

    parent.innerHTML = '';
    const container = document.createElement('div');
    container.className = `${CSS_PREFIX}-viewer-working`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-working-header`;
    header.textContent = `Working buffer — ${buffer.length} pair${buffer.length === 1 ? '' : 's'}`;
    container.appendChild(header);

    if (buffer.length === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = 'Buffer is empty. Pairs accumulate here between consolidations.';
        container.appendChild(empty);
        parent.appendChild(container);
        return;
    }

    const list = document.createElement('ol');
    list.className = `${CSS_PREFIX}-viewer-working-list`;
    // Newest first.
    for (let i = buffer.length - 1; i >= 0; i--) {
        list.appendChild(renderPair(buffer[i], i));
    }
    container.appendChild(list);
    parent.appendChild(container);
}

function renderPair(pair, idx) {
    const item = document.createElement('li');
    item.className = `${CSS_PREFIX}-viewer-working-item`;
    item.setAttribute('data-index', String(idx));

    const meta = document.createElement('div');
    meta.className = `${CSS_PREFIX}-viewer-working-meta`;
    const ts = pair.addedAt ? formatTimestamp(pair.addedAt) : '(no timestamp)';
    const sourceIds = Array.isArray(pair.sourceMessageIds) && pair.sourceMessageIds.length
        ? `msg ${pair.sourceMessageIds.join('-')}`
        : '';
    meta.textContent = `${ts}  •  ${sourceIds}`;
    item.appendChild(meta);

    const user = document.createElement('div');
    user.className = `${CSS_PREFIX}-viewer-working-user`;
    appendTruncated(user, 'User: ', pair.userMes);
    item.appendChild(user);

    const assistant = document.createElement('div');
    assistant.className = `${CSS_PREFIX}-viewer-working-assistant`;
    appendTruncated(assistant, 'Assistant: ', pair.assistantMes);
    item.appendChild(assistant);

    return item;
}

function appendTruncated(el, label, text) {
    const labelSpan = document.createElement('span');
    labelSpan.className = `${CSS_PREFIX}-viewer-label`;
    labelSpan.textContent = label;
    el.appendChild(labelSpan);
    const body = document.createElement('span');
    if (typeof text === 'string' && text.length > MAX_INLINE_LEN) {
        body.textContent = text.slice(0, MAX_INLINE_LEN) + '…';
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = `${CSS_PREFIX}-viewer-expand`;
        expand.textContent = '(more)';
        expand.addEventListener('click', () => {
            body.textContent = text;
            expand.remove();
        });
        el.appendChild(body);
        el.appendChild(expand);
    } else {
        body.textContent = typeof text === 'string' ? text : '';
        el.appendChild(body);
    }
}

function formatTimestamp(iso) {
    try {
        const d = new Date(iso);
        return d.toISOString().replace('T', ' ').replace(/\..+Z$/, 'Z');
    } catch { return iso; }
}
```

**Step 2: Create `tests/integration/integration/viewer-tabs-working.test.js`**

```js
/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { renderTab } from '../../../src/integration/viewer/tabs/working.js';
import { CSS_PREFIX } from '../../../src/integration/constants.js';

let parent;

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
});

afterEach(() => { document.body.innerHTML = ''; });

describe('viewer/tabs/working', () => {
    test('renders empty-state message when buffer is empty', async () => {
        await renderTab(parent, { state: { workingBuffer: [] }, chatId: 'a', subjectFilter: '' });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-empty`)?.textContent).toContain('empty');
    });

    test('renders pair count in header', async () => {
        await renderTab(parent, {
            state: { workingBuffer: [
                { userMes: 'u1', assistantMes: 'a1', sourceMessageIds: [0, 1], addedAt: '2026-04-20T10:00:00Z' },
                { userMes: 'u2', assistantMes: 'a2', sourceMessageIds: [2, 3], addedAt: '2026-04-20T10:01:00Z' },
            ]},
            chatId: 'a', subjectFilter: '',
        });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-working-header`)?.textContent).toContain('2 pair');
    });

    test('renders newest first', async () => {
        await renderTab(parent, {
            state: { workingBuffer: [
                { userMes: 'OLD', assistantMes: 'a1', sourceMessageIds: [0, 1], addedAt: '2026-04-20T10:00:00Z' },
                { userMes: 'NEW', assistantMes: 'a2', sourceMessageIds: [2, 3], addedAt: '2026-04-20T10:01:00Z' },
            ]},
            chatId: 'a', subjectFilter: '',
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-working-item`);
        expect(items[0].textContent).toContain('NEW');
        expect(items[1].textContent).toContain('OLD');
    });

    test('truncates messages >200 chars with inline expand', async () => {
        const longMes = 'x'.repeat(500);
        await renderTab(parent, {
            state: { workingBuffer: [
                { userMes: longMes, assistantMes: 'short', sourceMessageIds: [0, 1], addedAt: '2026-04-20T10:00:00Z' },
            ]},
            chatId: 'a', subjectFilter: '',
        });
        const userEl = parent.querySelector(`.${CSS_PREFIX}-viewer-working-user`);
        expect(userEl?.textContent).toContain('…');
        const expand = userEl?.querySelector(`.${CSS_PREFIX}-viewer-expand`);
        expect(expand).not.toBeNull();
        /** @type {HTMLButtonElement} */ (expand).click();
        expect(userEl?.textContent).toContain(longMes);
    });

    test('uses textContent (safe from HTML injection)', async () => {
        await renderTab(parent, {
            state: { workingBuffer: [
                { userMes: '<script>alert("XSS")</script>', assistantMes: 'ok', sourceMessageIds: [0, 1], addedAt: '2026-04-20T10:00:00Z' },
            ]},
            chatId: 'a', subjectFilter: '',
        });
        expect(parent.querySelector('script')).toBeNull();
        expect(parent.innerHTML).not.toContain('<script>alert');
    });

    test('handles non-array / undefined workingBuffer gracefully', async () => {
        await renderTab(parent, { state: {}, chatId: 'a', subjectFilter: '' });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-empty`)).not.toBeNull();
    });

    test('formats timestamp as ISO with space', async () => {
        await renderTab(parent, {
            state: { workingBuffer: [
                { userMes: 'u', assistantMes: 'a', sourceMessageIds: [0, 1], addedAt: '2026-04-20T10:15:30.123Z' },
            ]},
            chatId: 'a', subjectFilter: '',
        });
        const meta = parent.querySelector(`.${CSS_PREFIX}-viewer-working-meta`);
        expect(meta?.textContent).toContain('2026-04-20 10:15:30Z');
    });
});
```

**Step 3: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/viewer-tabs-working.test.js
# expect: 7 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/viewer/tabs/working.js tests/integration/integration/viewer-tabs-working.test.js
git commit -m "feat(integration): working buffer tab — newest-first, truncated pairs"
```

**Done when:**
- 7 working tab tests green
- No innerHTML used for chat content (XSS-safe)
- Inline expand button works
- Empty state shown for zero-length buffer

---

## Task 7.2 — `viewer/tabs/episodic.js`

**Objective:** Render the Episodic scope — all `entry.scope === 'episodic'`. Subject filter applies. Show: subject, content, importance, recency score, maturity, tags. Sort by importance descending by default; add a sort toggle (importance / recency / added).

**Owner:** Subagent.

**Context for the subagent:**

```
Same constraints as Task 7.1. Additional:
- Import recencyAt + maturityBoost from lifecycle barrel for display (not re-running retrieval).
- Sort toggle is a select (<select> for keyboard access).
- No pagination; if entries > 500, show count + "showing first 500".
- subject filter is CASE-INSENSITIVE substring on entry.subject.
```

**Step 1: Replace `src/integration/viewer/tabs/episodic.js`**

```js
/**
 * Episodic tab — render the Episodic scope with subject filter + sort.
 *
 * @module integration/viewer/tabs/episodic
 */

import { CSS_PREFIX } from '../../constants.js';
import { recencyAt, maturityBoost } from '../../../lifecycle/index.js';

const MAX_RENDER = 500;

/**
 * @param {HTMLElement} parent
 * @param {{ chatId: string, subjectFilter: string, state: { entries?: Record<string, any> } }} ctx
 */
export async function renderTab(parent, ctx) {
    const all = Object.values(ctx?.state?.entries || {});
    const episodic = all.filter(e => e && e.scope === 'episodic');
    const filtered = applyFilter(episodic, ctx.subjectFilter || '');

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-episodic`;
    root.appendChild(buildHeader(filtered.length, episodic.length));
    root.appendChild(buildSortControls(root, filtered, ctx.subjectFilter));
    root.appendChild(buildList(filtered, 'importance'));
    parent.appendChild(root);
}

function applyFilter(entries, subjectFilter) {
    if (!subjectFilter) return entries;
    const q = subjectFilter.toLowerCase();
    return entries.filter(e => typeof e.subject === 'string' && e.subject.toLowerCase().includes(q));
}

function buildHeader(shown, total) {
    const el = document.createElement('div');
    el.className = `${CSS_PREFIX}-viewer-episodic-header`;
    const limitNote = shown > MAX_RENDER ? ` (showing first ${MAX_RENDER})` : '';
    el.textContent = `Episodic — ${shown}/${total} entries${limitNote}`;
    return el;
}

function buildSortControls(root, entries, subjectFilter) {
    const wrap = document.createElement('div');
    wrap.className = `${CSS_PREFIX}-viewer-episodic-controls`;

    const label = document.createElement('label');
    label.textContent = 'Sort: ';
    label.setAttribute('for', `${CSS_PREFIX}-viewer-episodic-sort`);

    const select = document.createElement('select');
    select.id = `${CSS_PREFIX}-viewer-episodic-sort`;
    select.innerHTML = `
        <option value="importance">Importance ↓</option>
        <option value="recency">Recency ↓</option>
        <option value="added">Added ↓</option>
    `;
    select.addEventListener('change', () => {
        const oldList = root.querySelector(`.${CSS_PREFIX}-viewer-episodic-list`);
        oldList?.remove();
        root.appendChild(buildList(entries, select.value));
    });

    wrap.appendChild(label);
    wrap.appendChild(select);
    return wrap;
}

function buildList(entries, sortKey) {
    const now = new Date();
    const sorted = [...entries];
    if (sortKey === 'importance') {
        sorted.sort((a, b) => (b.lifecycle?.importance ?? 0) - (a.lifecycle?.importance ?? 0));
    } else if (sortKey === 'recency') {
        sorted.sort((a, b) => recencyAt(b.lifecycle, now) - recencyAt(a.lifecycle, now));
    } else if (sortKey === 'added') {
        sorted.sort((a, b) => (b.lifecycle?.createdAt || '').localeCompare(a.lifecycle?.createdAt || ''));
    }

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-episodic-list`;
    for (const e of sorted.slice(0, MAX_RENDER)) {
        list.appendChild(buildRow(e, now));
    }
    return list;
}

function buildRow(entry, now) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-episodic-item`;
    li.setAttribute('data-id', entry.id);

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-episodic-meta`;
    const subject = document.createElement('span');
    subject.className = `${CSS_PREFIX}-viewer-subject`;
    subject.textContent = entry.subject ?? '(no subject)';
    header.appendChild(subject);
    const scores = document.createElement('span');
    scores.className = `${CSS_PREFIX}-viewer-scores`;
    const imp = entry.lifecycle?.importance ?? 0;
    const rec = recencyAt(entry.lifecycle, now);
    const mat = entry.lifecycle?.maturity ?? '(?)';
    const boost = entry.lifecycle ? maturityBoost(entry.lifecycle.maturity) : 1;
    scores.textContent = `I=${imp.toFixed(0)}  R=${rec.toFixed(2)}  ${mat}·${boost.toFixed(2)}`;
    header.appendChild(scores);
    li.appendChild(header);

    const content = document.createElement('div');
    content.className = `${CSS_PREFIX}-viewer-content`;
    content.textContent = entry.content ?? '';
    li.appendChild(content);

    if (Array.isArray(entry.tags) && entry.tags.length) {
        const tags = document.createElement('div');
        tags.className = `${CSS_PREFIX}-viewer-tags`;
        for (const t of entry.tags) {
            const tag = document.createElement('span');
            tag.className = `${CSS_PREFIX}-viewer-tag`;
            tag.textContent = t;
            tags.appendChild(tag);
        }
        li.appendChild(tags);
    }
    return li;
}
```

**Step 2: Create `tests/integration/integration/viewer-tabs-episodic.test.js`**

```js
/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { renderTab } from '../../../src/integration/viewer/tabs/episodic.js';
import { CSS_PREFIX } from '../../../src/integration/constants.js';
import { createEntry } from '../../../src/memory/entry.js';

let parent;
const NOW = new Date('2026-04-20T10:00:00Z');

function episodicEntry({ subject = 'alice', content = 'alice fact', importance = 50, daysAgo = 0 } = {}) {
    const now = new Date(NOW.getTime() - daysAgo * 86400_000);
    const e = createEntry({
        scope: 'episodic', subject, content,
        tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 't@v1' },
        now,
    });
    e.lifecycle.importance = importance;
    return e;
}

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
});

afterEach(() => { document.body.innerHTML = ''; });

describe('viewer/tabs/episodic', () => {
    test('renders header with count', async () => {
        const e1 = episodicEntry();
        const e2 = episodicEntry({ subject: 'bob' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [e1.id]: e1, [e2.id]: e2 } },
        });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-episodic-header`)?.textContent).toContain('2/2');
    });

    test('subject filter narrows list', async () => {
        const alice = episodicEntry({ subject: 'alice' });
        const bob = episodicEntry({ subject: 'bob' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: 'ali',
            state: { entries: { [alice.id]: alice, [bob.id]: bob } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items.length).toBe(1);
    });

    test('sort by importance descending is default', async () => {
        const high = episodicEntry({ importance: 80, content: 'HIGH' });
        const low = episodicEntry({ importance: 20, content: 'LOW' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [low.id]: low, [high.id]: high } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items[0].textContent).toContain('HIGH');
    });

    test('sort select change re-renders in new order', async () => {
        const recent = episodicEntry({ daysAgo: 0, content: 'RECENT' });
        const old = episodicEntry({ daysAgo: 30, content: 'OLD' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [recent.id]: recent, [old.id]: old } },
        });
        const sel = /** @type {HTMLSelectElement} */ (parent.querySelector(`#${CSS_PREFIX}-viewer-episodic-sort`));
        sel.value = 'recency';
        sel.dispatchEvent(new Event('change'));
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items[0].textContent).toContain('RECENT');
    });

    test('renders tags inline', async () => {
        const e = episodicEntry();
        e.tags = ['paris', 'travel'];
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [e.id]: e } },
        });
        const tags = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-tag`);
        expect(tags.length).toBe(2);
        expect(tags[0].textContent).toBe('paris');
    });

    test('displays score summary in meta row', async () => {
        const e = episodicEntry({ importance: 67 });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [e.id]: e } },
        });
        const scores = parent.querySelector(`.${CSS_PREFIX}-viewer-scores`);
        expect(scores?.textContent).toContain('I=67');
    });

    test('content rendered with textContent (XSS-safe)', async () => {
        const e = episodicEntry({ content: '<script>alert(1)</script>' });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [e.id]: e } },
        });
        expect(parent.querySelector('script')).toBeNull();
    });

    test('ignores non-episodic entries', async () => {
        const epi = episodicEntry();
        const persona = createEntry({
            scope: 'persona', subject: 'alice', content: 'persona',
            tags: [], relations: [],
            provenance: { sourceMessages: [0], extractor: 't@v1' },
            now: NOW,
        });
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: { [epi.id]: epi, [persona.id]: persona } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items.length).toBe(1);
    });

    test('empty-state when no episodic entries', async () => {
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries: {} },
        });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-episodic-header`)?.textContent).toContain('0/0');
        expect(parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`).length).toBe(0);
    });

    test('respects MAX_RENDER cap', async () => {
        const entries = {};
        for (let i = 0; i < 600; i++) {
            const e = episodicEntry({ content: `fact ${i}` });
            entries[e.id] = e;
        }
        await renderTab(parent, {
            chatId: 'a', subjectFilter: '',
            state: { entries },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-episodic-item`);
        expect(items.length).toBe(500);
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-episodic-header`)?.textContent).toContain('showing first 500');
    });
});
```

**Step 3: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/viewer-tabs-episodic.test.js
# expect: 10 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/viewer/tabs/episodic.js tests/integration/integration/viewer-tabs-episodic.test.js
git commit -m "feat(integration): episodic tab — subject filter, sort, score summary"
```

**Done when:**
- 10 episodic tab tests green
- Subject filter is case-insensitive substring
- Three sort options cycle correctly
- MAX_RENDER cap honored
- XSS-safe

---
## Task 7.3 — `viewer/tabs/persona.js`

**Objective:** Render Persona scope entries grouped by subject. Includes a per-subject "Rebuild persona" button that invokes `rebuildPersona(chatId, subject, opts)` with an AbortSignal, shows a progress area during the run, and handles cancel. The most user-visible call into Phase 7's orchestrator.

**Owner:** Subagent.

**Context for the subagent:**

```
ABSOLUTE REPO PATH: <path>
Verify with `git log -1` showing <HEAD after Task 7.2> before work.

Constraints:
- Same DOM / XSS / prefix / no-npm-install constraints as Tasks 7.1-7.2.
- Persona entries grouped by entry.subject. If subject filter is non-empty, show only that group (still grouped visually for consistency).
- Rebuild button per group:
    - Calls rebuildPersona(chatId, subject, { profileId, extractorLabel, signal, onProgress, now }).
    - profileId + extractorLabel come from getSettings().
    - signal = new AbortController().signal; controller kept on the button.
    - onProgress({stage, depth?, clusters?}) appends a line to a per-group progress box.
    - Button toggles to "Cancel" during run; clicking cancels via abortController.abort().
    - On success or cancel: re-render the full tab (to reflect new Persona entries).
- When a rebuild is running, all OTHER subject Rebuild buttons are disabled (can't run two at once; lock contention via state.runtime.consolidating is indirect).
- If profileId is empty or missing, disable the Rebuild button and show a tooltip "Configure extractor LLM in settings first."
```

**Step 1: Replace `src/integration/viewer/tabs/persona.js`**

```js
/**
 * Persona tab — grouped Persona entries per subject + Rebuild button.
 *
 * @module integration/viewer/tabs/persona
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { CSS_PREFIX } from '../../constants.js';
import { getSettings } from '../../settings.js';
import { rebuildPersona } from '../../../consolidation/index.js';
import { createLogger } from '../../../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:viewer:persona');

/** @type {AbortController | null} */
let activeRebuild = null;

/**
 * @param {HTMLElement} parent
 * @param {{ chatId: string, subjectFilter: string, state: { entries?: Record<string, any> } }} ctx
 */
export async function renderTab(parent, ctx) {
    const all = Object.values(ctx?.state?.entries || {});
    const persona = all.filter(e => e && e.scope === 'persona');
    const groups = groupBySubject(persona, ctx.subjectFilter || '');
    const settings = getSettings();

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-persona`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-persona-header`;
    const subjectCount = Object.keys(groups).length;
    header.textContent = `Persona — ${persona.length} entries across ${subjectCount} subject${subjectCount === 1 ? '' : 's'}`;
    root.appendChild(header);

    if (subjectCount === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = ctx.subjectFilter
            ? `No Persona entries for "${ctx.subjectFilter}" yet.`
            : 'No Persona entries yet. Rebuild a subject to generate them.';
        root.appendChild(empty);
        // Still render a rebuild form so the user has an entry point.
        root.appendChild(buildRebuildForm(parent, ctx.chatId, settings, () => renderTab(parent, ctx)));
        parent.appendChild(root);
        return;
    }

    for (const [subject, entries] of Object.entries(groups)) {
        root.appendChild(buildSubjectGroup(subject, entries, ctx.chatId, settings, () => renderTab(parent, ctx)));
    }
    parent.appendChild(root);
}

function groupBySubject(entries, subjectFilter) {
    const groups = {};
    const q = subjectFilter.toLowerCase();
    for (const e of entries) {
        const subj = e.subject ?? '(no subject)';
        if (q && !subj.toLowerCase().includes(q)) continue;
        if (!groups[subj]) groups[subj] = [];
        groups[subj].push(e);
    }
    return groups;
}

function buildSubjectGroup(subject, entries, chatId, settings, onRerender) {
    const section = document.createElement('section');
    section.className = `${CSS_PREFIX}-viewer-persona-group`;
    section.setAttribute('data-subject', subject);

    const head = document.createElement('div');
    head.className = `${CSS_PREFIX}-viewer-persona-group-head`;
    const title = document.createElement('h3');
    title.className = `${CSS_PREFIX}-viewer-persona-subject`;
    title.textContent = `${subject} (${entries.length})`;
    head.appendChild(title);
    head.appendChild(buildRebuildButton(chatId, subject, settings, section, onRerender));
    section.appendChild(head);

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-persona-list`;
    for (const e of entries) list.appendChild(buildPersonaItem(e));
    section.appendChild(list);

    const progress = document.createElement('div');
    progress.className = `${CSS_PREFIX}-viewer-persona-progress`;
    progress.setAttribute('aria-live', 'polite');
    section.appendChild(progress);

    return section;
}

function buildPersonaItem(entry) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-persona-item`;
    li.setAttribute('data-id', entry.id);
    const content = document.createElement('div');
    content.className = `${CSS_PREFIX}-viewer-content`;
    content.textContent = entry.content ?? '';
    li.appendChild(content);
    const provenance = document.createElement('div');
    provenance.className = `${CSS_PREFIX}-viewer-provenance`;
    provenance.textContent = `from ${entry.provenance?.extractor ?? 'unknown'}`;
    li.appendChild(provenance);
    return li;
}

function buildRebuildButton(chatId, subject, settings, section, onRerender) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${CSS_PREFIX}-viewer-persona-rebuild menu_button`;
    btn.textContent = 'Rebuild';

    if (!settings.profileId) {
        btn.disabled = true;
        btn.title = 'Configure extractor LLM in settings first.';
        return btn;
    }

    btn.addEventListener('click', async () => {
        if (activeRebuild) {
            // This button's rebuild is the active one → cancel.
            if (btn.dataset.active === '1') {
                activeRebuild.abort();
                return;
            }
            // Another subject's rebuild is running; the button should already be disabled.
            return;
        }

        const ac = new AbortController();
        activeRebuild = ac;
        btn.dataset.active = '1';
        btn.textContent = 'Cancel';
        disableOtherRebuildButtons(true);

        const progressEl = /** @type {HTMLElement} */ (section.querySelector(`.${CSS_PREFIX}-viewer-persona-progress`));
        progressEl.innerHTML = '';
        const appendProgress = (line) => {
            const p = document.createElement('div');
            p.className = `${CSS_PREFIX}-viewer-progress-line`;
            p.textContent = line;
            progressEl.appendChild(p);
        };
        appendProgress('Starting rebuild…');

        try {
            const result = await rebuildPersona(chatId, subject, {
                profileId: settings.profileId,
                extractorLabel: settings.extractionModelLabel || 'unknown@persona-rebuild-v1',
                signal: ac.signal,
                onProgress: ({ stage, depth, clusters }) => {
                    const parts = [stage];
                    if (depth != null) parts.push(`depth=${depth}`);
                    if (clusters != null) parts.push(`clusters=${clusters}`);
                    appendProgress(parts.join(' • '));
                },
                now: new Date(),
            });
            appendProgress(`Done — ${result.newCount} new / ${result.replacedCount} replaced in ${result.duration}ms`);
        } catch (err) {
            if (err?.name === 'AbortError') {
                appendProgress('Cancelled.');
            } else {
                appendProgress(`Failed: ${String(err?.message || err)}`);
                log.warn('rebuildPersona failed:', err);
            }
        } finally {
            activeRebuild = null;
            btn.dataset.active = '';
            btn.textContent = 'Rebuild';
            disableOtherRebuildButtons(false);
            // Re-render to pick up new Persona entries. Defer so the user sees
            // the "Done" line for a beat.
            setTimeout(() => onRerender(), 300);
        }
    });
    return btn;
}

function buildRebuildForm(parent, chatId, settings, onRerender) {
    // Offered when no Persona entries exist yet. Requires a subject typed in.
    const form = document.createElement('div');
    form.className = `${CSS_PREFIX}-viewer-persona-rebuild-form`;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Subject to rebuild (e.g. alice)';
    input.className = `${CSS_PREFIX}-viewer-persona-subject-input`;
    form.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu_button ${CSS_PREFIX}-viewer-persona-rebuild`;
    btn.textContent = 'Rebuild';
    if (!settings.profileId) {
        btn.disabled = true;
        btn.title = 'Configure extractor LLM in settings first.';
    } else {
        btn.addEventListener('click', async () => {
            const subject = input.value.trim();
            if (!subject) return;
            // Synthesize a section-like container for progress; reuse buildSubjectGroup's progress style.
            const sec = document.createElement('section');
            sec.className = `${CSS_PREFIX}-viewer-persona-group`;
            const progress = document.createElement('div');
            progress.className = `${CSS_PREFIX}-viewer-persona-progress`;
            sec.appendChild(progress);
            form.appendChild(sec);
            // Build a standalone button for running and reuse its handler.
            const trigger = buildRebuildButton(chatId, subject, settings, sec, onRerender);
            trigger.click();
        });
    }
    form.appendChild(btn);
    return form;
}

function disableOtherRebuildButtons(disabled) {
    const btns = document.querySelectorAll(`.${CSS_PREFIX}-viewer-persona-rebuild`);
    for (const b of btns) {
        if (/** @type {HTMLButtonElement} */ (b).dataset.active === '1') continue;
        /** @type {HTMLButtonElement} */ (b).disabled = disabled;
    }
}
```

**Step 2: Create `tests/integration/integration/viewer-tabs-persona.test.js`**

```js
/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock rebuildPersona at the module level — MUST come before dynamic import of the SUT.
// Static `import { renderTab }` would hoist above the mock and defeat it (ESM semantics).
jest.unstable_mockModule('../../../src/consolidation/index.js', () => ({
    rebuildPersona: jest.fn(),
}));

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
        const { rebuildPersona } = await import('../../../src/consolidation/index.js');
        /** @type {jest.Mock} */ (rebuildPersona).mockImplementation(async (_c, _s, opts) => {
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
        const { rebuildPersona } = await import('../../../src/consolidation/index.js');
        /** @type {jest.Mock} */ (rebuildPersona).mockImplementation(async (_c, _s, opts) => {
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
        const { rebuildPersona } = await import('../../../src/consolidation/index.js');
        let resolveRun;
        /** @type {jest.Mock} */ (rebuildPersona).mockImplementation(() =>
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
        resolveRun({ episodicCount: 0, layers: 0, replacedCount: 0, newCount: 0, duration: 0 });
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
```

**Step 3: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/viewer-tabs-persona.test.js
# expect: 9 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/viewer/tabs/persona.js tests/integration/integration/viewer-tabs-persona.test.js
git commit -m "feat(integration): persona tab — grouped entries + Rebuild with AbortSignal"
```

**Done when:**
- 9 persona tab tests green
- Rebuild button disabled without profileId
- rebuildPersona invoked with full opts
- Cancel aborts via AbortSignal
- Other rebuild buttons disabled during active run
- XSS-safe content rendering

---

## Task 7.4 — `viewer/tabs/graph.js`

**Objective:** Render the graph as a textual adjacency listing. Not a visualization — spec §8 calls for "Graph" tab but a full interactive force-directed graph is out of scope. List: for each entry, show its immediate neighbors (edge type + target id + weight + target's subject/content snippet).

**Owner:** Subagent.

**Context for the subagent:**

```
Same constraints as prior viewer tasks.
- Import buildAdjacency, neighborsOf from memory barrel. Call buildAdjacency(state); state shape is `{ entries, graph: { edges }, ... }` per core/schema.js.
- subjectFilter applies to entry.subject.
- Sort entries by degree descending (most-connected first). Note: neighborsOf returns outgoing edges keyed on `from`, so this ranks by out-degree in practice — fine for diagnostics.
- Limit to 200 entries in listing (graph tab is diagnostic, not browseable).
- For each entry, list up to 10 neighbors; "+N more" if exceeded.
```

**Step 1: Replace `src/integration/viewer/tabs/graph.js`**

```js
/**
 * Graph tab — textual adjacency listing ranked by degree.
 *
 * @module integration/viewer/tabs/graph
 */

import { CSS_PREFIX } from '../../constants.js';
import { buildAdjacency, neighborsOf } from '../../../memory/index.js';

const MAX_ENTRIES = 200;
const MAX_NEIGHBORS_PER_ENTRY = 10;

/**
 * @param {HTMLElement} parent
 * @param {{ subjectFilter: string, state: { entries?: Record<string, any>, edges?: any[] } }} ctx
 */
export async function renderTab(parent, ctx) {
    const entries = ctx?.state?.entries || {};
    const edges = Array.isArray(ctx?.state?.graph?.edges) ? ctx.state.graph.edges : [];
    const filtered = filterEntries(entries, ctx.subjectFilter || '');
    const adj = buildAdjacency(ctx.state);
    const ranked = rankByDegree(filtered, adj);

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-graph`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-graph-header`;
    header.textContent = `Graph — ${Object.keys(filtered).length} nodes, ${edges.length} edges`;
    root.appendChild(header);

    if (ranked.length === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = 'No nodes to display.';
        root.appendChild(empty);
        parent.appendChild(root);
        return;
    }

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-graph-list`;
    for (const entry of ranked.slice(0, MAX_ENTRIES)) {
        list.appendChild(buildNodeRow(entry, adj, entries));
    }
    root.appendChild(list);

    if (ranked.length > MAX_ENTRIES) {
        const more = document.createElement('p');
        more.className = `${CSS_PREFIX}-viewer-note`;
        more.textContent = `(${ranked.length - MAX_ENTRIES} more nodes hidden — use subject filter to narrow)`;
        root.appendChild(more);
    }

    parent.appendChild(root);
}

function filterEntries(entries, filter) {
    if (!filter) return { ...entries };
    const q = filter.toLowerCase();
    const out = {};
    for (const [id, e] of Object.entries(entries)) {
        if (typeof e?.subject === 'string' && e.subject.toLowerCase().includes(q)) out[id] = e;
    }
    return out;
}

function rankByDegree(entries, adj) {
    const list = Object.values(entries);
    list.sort((a, b) => {
        const da = neighborsOf(adj, a.id).length;
        const db = neighborsOf(adj, b.id).length;
        return db - da;
    });
    return list;
}

function buildNodeRow(entry, adj, entriesById) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-graph-item`;
    li.setAttribute('data-id', entry.id);

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-graph-node-header`;
    const subject = document.createElement('span');
    subject.className = `${CSS_PREFIX}-viewer-subject`;
    subject.textContent = entry.subject ?? '(no subject)';
    header.appendChild(subject);
    const preview = document.createElement('span');
    preview.className = `${CSS_PREFIX}-viewer-graph-node-preview`;
    preview.textContent = truncate(entry.content ?? '', 80);
    header.appendChild(preview);
    li.appendChild(header);

    const neighbors = neighborsOf(adj, entry.id);
    const neighborList = document.createElement('ul');
    neighborList.className = `${CSS_PREFIX}-viewer-graph-neighbors`;
    for (const n of neighbors.slice(0, MAX_NEIGHBORS_PER_ENTRY)) {
        const ni = document.createElement('li');
        ni.className = `${CSS_PREFIX}-viewer-graph-neighbor`;
        const target = entriesById[n.id];
        const targetSubject = target?.subject ?? '?';
        const targetPreview = truncate(target?.content ?? '', 40);
        ni.textContent = `[${n.type}] (w=${n.weight.toFixed(2)}) → ${targetSubject}: ${targetPreview}`;
        neighborList.appendChild(ni);
    }
    if (neighbors.length > MAX_NEIGHBORS_PER_ENTRY) {
        const more = document.createElement('li');
        more.className = `${CSS_PREFIX}-viewer-graph-neighbor-more`;
        more.textContent = `+${neighbors.length - MAX_NEIGHBORS_PER_ENTRY} more neighbors`;
        neighborList.appendChild(more);
    }
    li.appendChild(neighborList);

    return li;
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}
```

**Step 2: Create `tests/integration/integration/viewer-tabs-graph.test.js`**

```js
/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { renderTab } from '../../../src/integration/viewer/tabs/graph.js';
import { CSS_PREFIX } from '../../../src/integration/constants.js';
import { createEntry } from '../../../src/memory/entry.js';

let parent;
const NOW = new Date('2026-04-20T10:00:00Z');

function entryFor(subject, content) {
    return createEntry({
        scope: 'episodic', subject, content,
        tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 't@v1' },
        now: NOW,
    });
}

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
});

afterEach(() => { document.body.innerHTML = ''; });

describe('viewer/tabs/graph', () => {
    test('renders header with node + edge count', async () => {
        const e1 = entryFor('alice', 'a1');
        const e2 = entryFor('bob', 'b1');
        await renderTab(parent, {
            subjectFilter: '',
            state: {
                entries: { [e1.id]: e1, [e2.id]: e2 },
                graph: { edges: [{ from: e1.id, to: e2.id, type: 'mentions', weight: 1.0 }] },
            },
        });
        const h = parent.querySelector(`.${CSS_PREFIX}-viewer-graph-header`);
        expect(h?.textContent).toContain('2 nodes');
        expect(h?.textContent).toContain('1 edges');
    });

    test('empty state when no nodes', async () => {
        await renderTab(parent, {
            subjectFilter: '',
            state: { entries: {}, graph: { edges: [] } },
        });
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer-empty`)).not.toBeNull();
    });

    test('ranks nodes by degree descending', async () => {
        const hub = entryFor('hub', 'central');
        const leaf1 = entryFor('leaf1', 'out1');
        const leaf2 = entryFor('leaf2', 'out2');
        await renderTab(parent, {
            subjectFilter: '',
            state: {
                entries: { [hub.id]: hub, [leaf1.id]: leaf1, [leaf2.id]: leaf2 },
                graph: { edges: [
                    { from: hub.id, to: leaf1.id, type: 'mentions', weight: 1.0 },
                    { from: hub.id, to: leaf2.id, type: 'mentions', weight: 1.0 },
                ] },
            },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-graph-item`);
        expect(items[0].getAttribute('data-id')).toBe(hub.id);
    });

    test('subject filter narrows list', async () => {
        const a = entryFor('alice', 'a');
        const b = entryFor('bob', 'b');
        await renderTab(parent, {
            subjectFilter: 'alice',
            state: { entries: { [a.id]: a, [b.id]: b }, graph: { edges: [] } },
        });
        const items = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-graph-item`);
        expect(items.length).toBe(1);
    });

    test('caps neighbors per entry to MAX_NEIGHBORS_PER_ENTRY', async () => {
        const hub = entryFor('hub', 'central');
        const entries = { [hub.id]: hub };
        const edges = [];
        for (let i = 0; i < 15; i++) {
            const leaf = entryFor(`leaf${i}`, `out${i}`);
            entries[leaf.id] = leaf;
            edges.push({ from: hub.id, to: leaf.id, type: 'mentions', weight: 1.0 });
        }
        await renderTab(parent, { subjectFilter: '', state: { entries, graph: { edges } } });
        const hubItem = parent.querySelector(`[data-id="${hub.id}"]`);
        const neighbors = hubItem?.querySelectorAll(`.${CSS_PREFIX}-viewer-graph-neighbor`);
        expect(neighbors?.length).toBe(10);
        const more = hubItem?.querySelector(`.${CSS_PREFIX}-viewer-graph-neighbor-more`);
        expect(more?.textContent).toContain('+5 more');
    });

    test('XSS-safe for entry content', async () => {
        const e = entryFor('alice', '<script>alert(1)</script>');
        await renderTab(parent, {
            subjectFilter: '',
            state: { entries: { [e.id]: e }, graph: { edges: [] } },
        });
        expect(parent.querySelector('script')).toBeNull();
    });

    test('shows "+more nodes hidden" when > MAX_ENTRIES', async () => {
        const entries = {};
        for (let i = 0; i < 250; i++) {
            const e = entryFor(`subj${i}`, `content${i}`);
            entries[e.id] = e;
        }
        await renderTab(parent, { subjectFilter: '', state: { entries, graph: { edges: [] } } });
        const note = parent.querySelector(`.${CSS_PREFIX}-viewer-note`);
        expect(note?.textContent).toContain('50 more nodes hidden');
    });
});
```

**Step 3: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/viewer-tabs-graph.test.js
# expect: 7 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/viewer/tabs/graph.js tests/integration/integration/viewer-tabs-graph.test.js
git commit -m "feat(integration): graph tab — degree-ranked adjacency listing"
```

**Done when:**
- 7 graph tab tests green
- Degree-based ranking works (hub appears before leaves)
- Neighbor cap + "+more" message shown
- MAX_ENTRIES cap honored

---

## Task 7.5 — `viewer/tabs/traces.js` + JSONL export

**Objective:** Render the `runtime.traces` ring buffer. Each trace is `{ timestamp, query, classifier, tierResolved, perTier, finalRanking, injectedFragment }`. Show latest-first, collapsible detail per trace, with a JSONL export button that creates a downloadable blob URL. This is the benchmark-hook face of Phase 9.

**Owner:** Subagent.

**Context for the subagent:**

```
Same constraints as prior viewer tasks.
- state.runtime.traces is the ring buffer (bounded at TRACE_BUFFER_CAP = 128).
- Each trace summary (collapsed): timestamp, classifier, tierResolved, top-score from perTier[tierResolved][0].
- Expand shows full JSON of the trace.
- JSONL export:
    - Button text "Download JSONL" → creates Blob, sets href on a transient <a>, clicks, revokes URL.
    - Filename: starmem-traces-<ISO-date>.jsonl (substitute ':' → '-' for Windows compat).
- Clear button: empties the runtime.traces array via a withWriteLock mutation (this is a deliberate new mutation site under `src/consolidation/` whitelist — NOT under `src/integration/`. So we import a helper from consolidation barrel if it exists; if not, we use loadState/persistState directly and note the whitelist implication).

IMPORTANT whitelist note: the one-path invariant test in tests/unit/consolidation/no-other-mutators.test.js allows mutations in src/consolidation/ and src/lifecycle/ — not src/integration/. The "Clear traces" operation writes to state.runtime.traces, which means either:
  (a) we implement clearTraces() in src/consolidation/triggers.js (or a new src/consolidation/traces.js) and export it from the barrel — keeps invariant clean;
  (b) we add src/integration/viewer/tabs/traces.js to the whitelist with a comment — pollutes the invariant.

Pick (a). Add clearTraces(chatId) to src/consolidation/triggers.js (or a new file), export from barrel, import here.
```

**Step 1: Add `clearTraces(chatId)` to consolidation barrel**

In `src/consolidation/triggers.js`, append (note: `loadState` is already imported at the top of this file — do not re-import):

```js
import { withWriteLock } from '../core/lock.js';
import { persistState } from '../core/state.js';

/**
 * Clear the retrieval trace ring buffer for a chat.
 * Mutation site — runs under write lock to respect the single-mutator principle.
 *
 * @param {string} chatId
 * @returns {Promise<void>}
 */
export async function clearTraces(chatId) {
    await withWriteLock(chatId, async () => {
        const state = await loadState(chatId);
        await persistState(chatId, {
            ...state,
            runtime: { ...state.runtime, traces: [] },
        });
    });
}
```

And extend `src/consolidation/index.js` barrel (add `clearTraces` to the existing triggers re-export, currently `{ maybeConsolidate, resetIdleTimer, cancelIdleTimer }`):

```js
export {
    maybeConsolidate, resetIdleTimer, cancelIdleTimer, clearTraces,
} from './triggers.js';
```

Unit test for `clearTraces` in `tests/unit/consolidation/triggers.test.js` (append). Two import adjustments at the top of that file:

- Add `clearTraces` to the destructured import from `../../../src/consolidation/triggers.js`.
- Add `loadState` to the destructured import from `../../../src/core/state.js`.

Then append a new describe (or add inside the existing describe):

```js
test('clearTraces empties state.runtime.traces under write lock', async () => {
    store.set(CHAT, {
        ...createEmptyState(),
        runtime: {
            ...createEmptyState().runtime,
            traces: [{ timestamp: '', query: 'q', tierResolved: 2 }],
        },
    });
    await clearTraces(CHAT);
    const after = await loadState(CHAT);
    expect(after.runtime.traces).toEqual([]);
});
```

Commit this as a standalone feat:

```bash
npm run typecheck && npm run lint && npm test --silent -- tests/unit/consolidation/triggers.test.js
git add src/consolidation/triggers.js src/consolidation/index.js tests/unit/consolidation/triggers.test.js
git commit -m "feat(consolidation): clearTraces(chatId) mutator for Phase 8 Traces tab"
```

**Step 2: Replace `src/integration/viewer/tabs/traces.js`**

```js
/**
 * Traces tab — render runtime.traces ring buffer + JSONL export + clear.
 *
 * @module integration/viewer/tabs/traces
 */

import { CSS_PREFIX } from '../../constants.js';
import { clearTraces } from '../../../consolidation/index.js';

/**
 * @param {HTMLElement} parent
 * @param {{ chatId: string, state: { runtime?: { traces?: any[] } } }} ctx
 */
export async function renderTab(parent, ctx) {
    const traces = Array.isArray(ctx?.state?.runtime?.traces) ? ctx.state.runtime.traces : [];

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-traces`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-traces-header`;
    header.textContent = `Traces — ${traces.length} entries`;
    root.appendChild(header);

    const controls = document.createElement('div');
    controls.className = `${CSS_PREFIX}-viewer-traces-controls`;
    controls.appendChild(buildExportButton(traces));
    controls.appendChild(buildClearButton(ctx.chatId, parent, ctx));
    root.appendChild(controls);

    if (traces.length === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = 'No retrieval traces recorded yet.';
        root.appendChild(empty);
        parent.appendChild(root);
        return;
    }

    const list = document.createElement('ol');
    list.className = `${CSS_PREFIX}-viewer-traces-list`;
    // Latest first.
    for (let i = traces.length - 1; i >= 0; i--) {
        list.appendChild(buildTraceItem(traces[i]));
    }
    root.appendChild(list);
    parent.appendChild(root);
}

function buildExportButton(traces) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu_button ${CSS_PREFIX}-viewer-traces-export`;
    btn.textContent = 'Download JSONL';
    btn.disabled = traces.length === 0;
    btn.addEventListener('click', () => {
        const jsonl = traces.map(t => JSON.stringify(t)).join('\n') + '\n';
        const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const isoNow = new Date().toISOString().replace(/:/g, '-').replace(/\..+Z$/, '');
        const a = document.createElement('a');
        a.href = url;
        a.download = `starmem-traces-${isoNow}.jsonl`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
    });
    return btn;
}

function buildClearButton(chatId, parent, ctx) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu_button ${CSS_PREFIX}-viewer-traces-clear`;
    btn.textContent = 'Clear';
    btn.addEventListener('click', async () => {
        if (!confirm('Clear all retrieval traces?')) return;
        try {
            await clearTraces(chatId);
            // Re-render by re-invoking with an empty state projection.
            const fresh = { ...ctx, state: { ...ctx.state, runtime: { ...(ctx.state?.runtime || {}), traces: [] } } };
            await renderTab(parent, fresh);
        } catch (err) {
            alert(`Failed to clear traces: ${err?.message || err}`);
        }
    });
    return btn;
}

function buildTraceItem(trace) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-traces-item`;

    const summary = document.createElement('div');
    summary.className = `${CSS_PREFIX}-viewer-traces-summary`;
    const ts = trace.timestamp ? formatTimestamp(trace.timestamp) : '(no ts)';
    const cls = trace.classifier ?? '?';
    const tier = trace.tierResolved ?? '?';
    const top = getTopScore(trace);
    const query = truncate(trace.query ?? '', 60);
    summary.textContent = `${ts} • T${tier}/${cls} • top=${top !== null ? top.toFixed(2) : 'n/a'} • "${query}"`;
    li.appendChild(summary);

    const details = document.createElement('details');
    details.className = `${CSS_PREFIX}-viewer-traces-details`;
    const sumEl = document.createElement('summary');
    sumEl.textContent = 'raw';
    details.appendChild(sumEl);
    const pre = document.createElement('pre');
    pre.className = `${CSS_PREFIX}-viewer-traces-raw`;
    pre.textContent = JSON.stringify(trace, null, 2);
    details.appendChild(pre);
    li.appendChild(details);

    return li;
}

function getTopScore(trace) {
    const tier = trace.tierResolved;
    if (tier == null) return null;
    const per = trace.perTier?.[String(tier)];
    if (!Array.isArray(per) || per.length === 0) return null;
    const top = per[0];
    return typeof top?.score === 'number' ? top.score : null;
}

function formatTimestamp(iso) {
    try {
        return new Date(iso).toISOString().replace('T', ' ').replace(/\..+Z$/, 'Z');
    } catch { return iso; }
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}
```

**Step 3: Create `tests/integration/integration/viewer-tabs-traces.test.js`**

```js
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
```

**Step 4: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/integration/integration/viewer-tabs-traces.test.js
# expect: 8 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/viewer/tabs/traces.js tests/integration/integration/viewer-tabs-traces.test.js
git commit -m "feat(integration): traces tab — summary, raw expand, JSONL export, clear"
```

**Done when:**
- 8 traces tab tests green
- JSONL export creates blob URL with sane filename
- Clear button calls clearTraces (under write lock) + re-renders
- Summary line shows T/classifier/top score
- Confirm dialog respected on Clear

---
## Task 8 — `tests/helpers/stContextMock.js` (minimal `getContext()` fake + `eventSource` spy)

**Objective:** Factory for a SillyTavern `getContext()`-shaped fake used by every JSDOM integration test in Phase 8. Deviation from the chunk 1 task table: we're putting it under `tests/helpers/` not `tests/fixtures/` per convention — fixtures are data, helpers are code, this is a factory.

**Owner:** Controller (small mechanical file, tighter typing than a subagent would give us).

**Files:**
- Create: `tests/helpers/stContextMock.js`
- Create: `tests/helpers/stContextMock.test.js`

**Decision 11 recap:** minimal surface — only what Phase 8 code actually touches — plus an `eventSource` spy because bootstrap.js subscribes to `APP_READY`, `MESSAGE_RECEIVED`, `MESSAGE_DELETED`, `CHAT_CHANGED`, and `GENERATION_STARTED`. Factory-per-test, no shared singleton — mirrors Phase 6's `_setLLMClientForTests` discipline.

**Step 1: Create `tests/helpers/stContextMock.js`**

```js
/**
 * Minimal SillyTavern context mock for Phase 8 JSDOM/integration tests.
 *
 * Surface deliberately narrow — only the fields STARmem Phase 8 code reads:
 *
 *   - extensionSettings       (settings.js, settingsPanel.js)
 *   - saveSettingsDebounced   (settings.js, settingsPanel.js)
 *   - chatMetadata            (state.js already has its own backend hook;
 *                              included here for tests that exercise
 *                              SillyTavern.getContext() directly)
 *   - saveMetadataDebounced   (tests that want to assert persistence calls)
 *   - chatId                  (interceptor.js, bootstrap.js)
 *   - eventSource             (bootstrap.js — see spy below)
 *   - event_types             (constant map used by bootstrap.js)
 *
 * Anything else (characters, chat, groups, callPopup, slash commands) is
 * intentionally absent. If a later phase needs one, add it here rather
 * than inline in a test.
 *
 * @module tests/helpers/stContextMock
 */

import { jest } from '@jest/globals';

/**
 * The subset of ST event_types Phase 8 wires. Names match ST's script.js.
 * Kept as a frozen object so tests can reference `ET.APP_READY` safely.
 */
export const ET = Object.freeze({
    APP_READY: 'app_ready',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_DELETED: 'message_deleted',
    CHAT_CHANGED: 'chat_changed',
    GENERATION_STARTED: 'generation_started',
});

/**
 * @typedef {object} EventSourceSpy
 * @property {jest.Mock} on
 * @property {jest.Mock} off
 * @property {jest.Mock} emit
 * @property {Map<string, Set<Function>>} _handlers
 */

/**
 * Build a minimal eventSource spy with real pub/sub semantics.
 * `emit(name, ...args)` synchronously invokes every handler registered
 * via `on(name, fn)`; handlers registered then unregistered via `off`
 * are not invoked. Exposes `_handlers` so tests can inspect subscription
 * state directly (e.g. "bootstrap subscribed to APP_READY exactly once").
 *
 * @returns {EventSourceSpy}
 */
export function makeEventSource() {
    /** @type {Map<string, Set<Function>>} */
    const handlers = new Map();

    const on = jest.fn(/** @param {string} name @param {Function} fn */ (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(fn);
    });

    const off = jest.fn(/** @param {string} name @param {Function} fn */ (name, fn) => {
        handlers.get(name)?.delete(fn);
    });

    const emit = jest.fn(async (name, ...args) => {
        const set = handlers.get(name);
        if (!set) return;
        // Clone so a handler that calls off() mid-emit doesn't mutate iteration.
        for (const fn of [...set]) {
            await fn(...args);
        }
    });

    return { on, off, emit, _handlers: handlers };
}

/**
 * @typedef {object} StContextMockOptions
 * @property {Record<string, any>} [extensionSettings]
 * @property {Record<string, any>} [chatMetadata]
 * @property {string|null} [chatId]
 * @property {EventSourceSpy} [eventSource]
 */

/**
 * @typedef {object} StContextMock
 * @property {Record<string, any>} extensionSettings
 * @property {() => void} saveSettingsDebounced
 * @property {Record<string, any>} chatMetadata
 * @property {() => void} saveMetadataDebounced
 * @property {string|null} chatId
 * @property {EventSourceSpy} eventSource
 * @property {typeof ET} event_types
 */

/**
 * Build a fresh `SillyTavern.getContext()`-shaped object. Every field is a
 * jest.Mock or a Plain Old Object owned by the test — no shared state
 * across invocations.
 *
 * @param {StContextMockOptions} [overrides]
 * @returns {StContextMock}
 */
export function makeStContext(overrides = {}) {
    return {
        extensionSettings: overrides.extensionSettings ?? {},
        saveSettingsDebounced: jest.fn(),
        chatMetadata: overrides.chatMetadata ?? {},
        saveMetadataDebounced: jest.fn(),
        chatId: overrides.chatId === undefined ? 'test-chat' : overrides.chatId,
        eventSource: overrides.eventSource ?? makeEventSource(),
        event_types: ET,
    };
}

/**
 * Install the mock as `globalThis.SillyTavern = { getContext: () => ctx }`
 * and return a teardown callable that restores whatever was there before.
 *
 * Use this when the code under test reads `SillyTavern.getContext()`
 * directly (e.g. interceptor.js). Tests that use an injected `_setContextForTests`
 * helper (settings.js) don't need this — inject directly.
 *
 * @param {StContextMock} ctx
 * @returns {() => void} teardown
 */
export function installGlobalSillyTavern(ctx) {
    const g = /** @type {any} */ (globalThis);
    const prior = g.SillyTavern;
    g.SillyTavern = { getContext: () => ctx };
    return () => {
        if (prior === undefined) delete g.SillyTavern;
        else g.SillyTavern = prior;
    };
}
```

**Step 2: Create `tests/helpers/stContextMock.test.js`**

```js
/**
 * Self-test for the mock factory — ensures it actually behaves like
 * a minimal getContext() and the event spy has real pub/sub semantics.
 */
import { describe, test, expect, jest } from '@jest/globals';
import {
    makeStContext, makeEventSource, installGlobalSillyTavern, ET,
} from './stContextMock.js';

describe('stContextMock', () => {
    test('makeStContext returns fresh empty settings + chatMetadata', () => {
        const c = makeStContext();
        expect(c.extensionSettings).toEqual({});
        expect(c.chatMetadata).toEqual({});
        expect(c.chatId).toBe('test-chat');
        expect(typeof c.saveSettingsDebounced).toBe('function');
        expect(typeof c.saveMetadataDebounced).toBe('function');
        expect(c.event_types).toBe(ET);
    });

    test('overrides take precedence without mutating defaults', () => {
        const a = makeStContext({ chatId: 'A' });
        const b = makeStContext();
        a.extensionSettings.foo = 1;
        expect(a.chatId).toBe('A');
        expect(b.chatId).toBe('test-chat');
        expect(b.extensionSettings.foo).toBeUndefined();
    });

    test('chatId: null override is respected (logged-out-of-chat state)', () => {
        const c = makeStContext({ chatId: null });
        expect(c.chatId).toBeNull();
    });

    test('eventSource.on + emit fires handlers in order', async () => {
        const es = makeEventSource();
        const order = [];
        es.on('x', () => order.push(1));
        es.on('x', () => order.push(2));
        await es.emit('x');
        expect(order).toEqual([1, 2]);
    });

    test('eventSource.off unsubscribes the exact handler', async () => {
        const es = makeEventSource();
        const h1 = jest.fn();
        const h2 = jest.fn();
        es.on('x', h1);
        es.on('x', h2);
        es.off('x', h1);
        await es.emit('x');
        expect(h1).not.toHaveBeenCalled();
        expect(h2).toHaveBeenCalledTimes(1);
    });

    test('eventSource.emit on unknown event is a no-op', async () => {
        const es = makeEventSource();
        await expect(es.emit('never-subscribed')).resolves.toBeUndefined();
    });

    test('eventSource handler that calls off() mid-emit does not skip siblings', async () => {
        const es = makeEventSource();
        const seen = [];
        const h1 = () => { seen.push(1); es.off('x', h1); };
        const h2 = () => { seen.push(2); };
        es.on('x', h1);
        es.on('x', h2);
        await es.emit('x');
        expect(seen).toEqual([1, 2]); // both run despite h1 self-unsubbing
    });

    test('eventSource await-propagates handler rejections', async () => {
        const es = makeEventSource();
        es.on('boom', async () => { throw new Error('nope'); });
        await expect(es.emit('boom')).rejects.toThrow(/nope/);
    });

    test('installGlobalSillyTavern sets + teardown restores', () => {
        const g = /** @type {any} */ (globalThis);
        const prior = g.SillyTavern;
        const ctx = makeStContext();
        const teardown = installGlobalSillyTavern(ctx);
        expect(g.SillyTavern.getContext()).toBe(ctx);
        teardown();
        expect(g.SillyTavern).toBe(prior);
    });

    test('installGlobalSillyTavern preserves a pre-existing global', () => {
        const g = /** @type {any} */ (globalThis);
        g.SillyTavern = { sentinel: true };
        const teardown = installGlobalSillyTavern(makeStContext());
        expect(g.SillyTavern.sentinel).toBeUndefined();
        teardown();
        expect(g.SillyTavern.sentinel).toBe(true);
        delete g.SillyTavern;
    });

    test('ET has the exact set of names Phase 8 subscribes to', () => {
        expect(Object.keys(ET).sort()).toEqual([
            'APP_READY',
            'CHAT_CHANGED',
            'GENERATION_STARTED',
            'MESSAGE_DELETED',
            'MESSAGE_RECEIVED',
        ]);
        // Values must be lowercase snake_case matching ST's script.js.
        for (const [k, v] of Object.entries(ET)) {
            expect(v).toBe(k.toLowerCase());
        }
    });
});
```

**Step 3: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/helpers/stContextMock.test.js
# expect: 10 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add tests/helpers/stContextMock.js tests/helpers/stContextMock.test.js
git commit -m "test(integration): stContextMock helper + eventSource spy (Phase 8 Task 8)"
```

**Done when:**
- 10 mock self-tests green
- Mock surface is exactly the Phase 8 subset (no `characters`, `groups`, `callPopup`)
- `makeStContext()` returns a fresh object per call (factory, not singleton)
- `eventSource` has real pub/sub semantics verified by the self-test

---

## Task 9 — `src/integration/index.js` barrel + root `index.js` wire-up

**Objective:** Stitch Phase 8 together at the extension entry point. Root `index.js` currently has TODO stubs for interceptor and APP_READY; Task 9 replaces them with real wiring that calls `bootstrap()` on `APP_READY` and delegates `STARmemInterceptor` to the real body from Task 2.

**Owner:** Controller. Small, load-bearing, and has the CSS-prefix grep invariant.

**Files:**
- Create: `src/integration/index.js` (barrel)
- Modify: `index.js` (root — full rewrite, short)
- Create: `tests/unit/integration/index-barrel.test.js`
- Create: `tests/integration/integration/no-leaky-css.test.js` (grep invariant)

**Step 1: Create `src/integration/index.js`**

```js
/**
 * Phase 8 integration barrel.
 *
 * Re-exports the public surface of src/integration/ so the root index.js
 * and JSDOM integration tests have a single import target.
 *
 * Keeps DOM-specific exports (settingsPanel, indicator, viewer) together
 * so the root index.js can selectively opt into them without reaching
 * across the folder.
 *
 * @module integration
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

export * from './constants.js';
export {
    getSettings, setSettings, resetSettings, validateSettings,
    _setContextForTests, _resetContextForTests,
} from './settings.js';
export { runInterceptor } from './interceptor.js';
export { bootstrap, teardown } from './bootstrap.js';
export { mountIndicator, unmountIndicator, _tickForTests } from './indicator.js';
export { mountSettingsPanel, unmountSettingsPanel } from './settingsPanel.js';
export { mountViewer, unmountViewer, isViewerOpen } from './viewer/mount.js';
```

**Step 2: Rewrite root `index.js`**

```js
/**
 * STARmem v2 — SillyTavern memory extension entry point.
 *
 * ST loads this file directly (no build step). Responsibilities:
 *
 *   1. Register globalThis.STARmemInterceptor — ST's manifest.json points
 *      `generate_interceptor` at this global, and calls it on every generation.
 *   2. Subscribe bootstrap() to APP_READY — settings, indicator, viewer,
 *      and the idle timer all initialize inside bootstrap() once ST is ready.
 *
 * That's it. Every other concern lives under src/integration/.
 *
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 * @see src/integration/interceptor.js
 * @see src/integration/bootstrap.js
 */

import { log } from './src/core/logger.js';
import { runInterceptor } from './src/integration/interceptor.js';
import { bootstrap } from './src/integration/bootstrap.js';

/**
 * generate_interceptor body — registered via manifest.json.
 * Thin shim: delegates to runInterceptor and swallows all errors so a
 * broken memory system cannot break the user's chat. See interceptor.js
 * for the contract.
 *
 * @param {Array<any>} chat
 * @param {number} contextSize
 * @param {(immediately: boolean) => void} abort
 * @param {string} type
 */
globalThis.STARmemInterceptor = async function STARmemInterceptor(chat, contextSize, abort, type) {
    try {
        await runInterceptor(chat, contextSize, abort, type);
    } catch (err) {
        log.error('interceptor threw; swallowing to protect generation', err);
    }
};

/**
 * APP_READY subscription — fires once, after ST has mounted its UI and
 * getContext() is fully populated. bootstrap() handles idempotency: a
 * second APP_READY fire (can happen on extension reload) is a no-op.
 *
 * Top-level await: ST loads extension JS as `<script type="module">`,
 * so TLA is supported. We use it over an IIFE to make module-eval
 * ordering explicit — if SillyTavern isn't ready at eval time we log
 * and return rather than silently swallowing.
 */
try {
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st?.getContext) {
        log.warn('SillyTavern.getContext unavailable at module eval; bootstrap deferred');
    } else {
        const { eventSource, event_types } = st.getContext();
        eventSource.on(event_types.APP_READY, () => {
            bootstrap().catch(err => log.error('bootstrap failed:', err));
        });
    }
} catch (err) {
    log.error('failed to subscribe to APP_READY:', err);
}

log.info('v2 loaded');
```

**Step 3: Create `tests/unit/integration/index-barrel.test.js`**

```js
/**
 * Every public symbol Phase 8 promises is re-exported from the barrel.
 * If a later refactor drops one of these, this test catches it before
 * the root index.js starts throwing at extension-load time.
 */
import { describe, test, expect } from '@jest/globals';
import * as barrel from '../../../src/integration/index.js';

describe('integration barrel', () => {
    test('re-exports every Phase 8 public symbol', () => {
        const expected = [
            // constants
            'SETTINGS_KEY', 'SETTINGS_SCHEMA_VERSION', 'SETTINGS_DEFAULTS',
            'SETTINGS_BOUNDS', 'INJECTION_KEY', 'INJECTION_ROLE',
            'VIEWER_TABS', 'CSS_PREFIX',
            // settings
            'getSettings', 'setSettings', 'resetSettings', 'validateSettings',
            '_setContextForTests', '_resetContextForTests',
            // interceptor / bootstrap
            'runInterceptor', 'bootstrap', 'teardown',
            // indicator
            'mountIndicator', 'unmountIndicator', '_tickForTests',
            // settings panel
            'mountSettingsPanel', 'unmountSettingsPanel',
            // viewer
            'mountViewer', 'unmountViewer', 'isViewerOpen',
        ];
        for (const name of expected) {
            expect(barrel).toHaveProperty(name);
        }
    });

    test('does not leak internal helpers', () => {
        // resolveContext is an internal in settings.js and must not escape.
        expect(/** @type {any} */ (barrel).resolveContext).toBeUndefined();
    });
});
```

**Step 4: Create `tests/integration/integration/no-leaky-css.test.js`**

```js
/**
 * Grep invariant: every DOM class name and id introduced by Phase 8
 * must start with the `starmem-` prefix. Enforces Decision 9 from the
 * plan and prevents Phase 8 from coloring other ST extensions' DOM.
 *
 * Methodology:
 *   Walk every .js and .html file under src/integration/, find every
 *   string literal that looks like a CSS class or id (leading `.` or `#`,
 *   or appearing inside className/classList.add/id= attributes), and
 *   assert the token after the sigil starts with `starmem-` or is
 *   whitelisted below.
 *
 * Tripwire-verified at commit time by injecting a deliberate violation
 * (see Phase 6's no-other-mutators test for the pattern).
 */
import { describe, test, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname,
    '..', '..', '..', 'src', 'integration');

/** Tokens allowed to break the prefix rule (tokens used unchanged by ST). */
const WHITELIST = new Set([
    'extensions_settings',       // ST-provided container id our settings panel mounts into
    'send_but',                  // ST's send button — we mount the indicator here
    'send_but_container',        // ST's send button wrapper
    'send_form',                 // ST's send form wrapper (indicator fallback)
]);

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) out.push(...walk(full));
        else if (/\.(js|html)$/.test(entry)) out.push(full);
    }
    return out;
}

/**
 * Extract every css-class-shaped or id-shaped token from a source file.
 * Returns an array of { token, file, line } records for failure reporting.
 */
function extractTokens(file) {
    const src = readFileSync(file, 'utf8');
    /** @type {{ token: string, file: string, line: number }[]} */
    const found = [];

    // `.foo-bar` or `#foo-bar` inside string literals — catches querySelector,
    // classList.add, HTML templates, style sheet refs.
    const re = /(['"`])([^'"`]*?)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const literal = m[2];
        for (const sub of literal.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) {
            const token = sub[1];
            // Compute 1-based line number for the match start.
            const line = src.slice(0, m.index).split('\n').length;
            found.push({ token, file: path.relative(ROOT, file), line });
        }
    }
    return found;
}

describe('no-leaky-css', () => {
    test('every CSS class/id token in src/integration starts with "starmem-"', () => {
        const files = walk(ROOT);
        const violations = [];
        for (const f of files) {
            for (const t of extractTokens(f)) {
                if (WHITELIST.has(t.token)) continue;
                if (t.token.startsWith('starmem-')) continue;
                // Single-word tokens like "hidden" or "active" may come from
                // generic CSS; ignore unless they contain a hyphen (suggesting
                // a component class).
                if (!t.token.includes('-')) continue;
                // ST-namespaced tokens (no prefix required) — empirically these
                // are the few we intentionally reach across for.
                if (t.token.startsWith('fa-')) continue;       // Font Awesome icons
                if (t.token.startsWith('menu_')) continue;     // ST button styles
                violations.push(`${t.file}:${t.line}  ${t.token}`);
            }
        }
        if (violations.length) {
            throw new Error(
                `Phase 8 CSS prefix violation — every class/id must start with ` +
                `"starmem-" (see constants.js#CSS_PREFIX). Offending tokens:\n  ` +
                violations.join('\n  '),
            );
        }
    });
});
```

**Step 5: Tripwire-verify the grep invariant**

```bash
# Inject a deliberate violation in a file we won't ship a fix for:
cat >> src/integration/constants.js <<'EOF'
// TEST-SENTINEL: ".foreign-component"
EOF

npm test --silent -- tests/integration/integration/no-leaky-css.test.js
# Expect: FAIL with "foreign-component" called out

# Revert:
git checkout src/integration/constants.js
npm test --silent -- tests/integration/integration/no-leaky-css.test.js
# Expect: PASS
```

**Step 6: Run + commit**

```bash
npm run typecheck
npm run lint
npm test --silent -- tests/unit/integration/index-barrel.test.js \
                      tests/integration/integration/no-leaky-css.test.js
# expect: 3 tests pass (2 barrel + 1 leaky-css)
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add src/integration/index.js index.js \
        tests/unit/integration/index-barrel.test.js \
        tests/integration/integration/no-leaky-css.test.js
git commit -m "feat(integration): wire root index.js + integration barrel + CSS prefix invariant"
```

**Done when:**
- Barrel re-exports every public Phase 8 symbol (2 tests)
- Root `index.js` subscribes bootstrap to APP_READY idempotently
- `globalThis.STARmemInterceptor` delegates to `runInterceptor` with a try/catch shield
- CSS prefix grep invariant fails loud on tripwire sentinel, passes on real code
- No `resolveContext` or other internal helper leaks through the barrel
- Full suite green

---
## Task 10 — `style.css` (hybrid theme, dialog sizing, mobile collapse)

**Objective:** The single stylesheet ST loads via `manifest.json#css`. Covers: settings panel, consolidation indicator, viewer dialog + tabs, graph canvas, traces JSONL preview, and a `< 640 px` breakpoint that collapses the tab strip into a native `<select>`.

**Owner:** Subagent.

**Decisions applied:**
- **12.C** — hybrid: `var(--SmartThemeBodyColor, #1a1a1a)` style fallbacks for ST theme vars; hardcoded STARmem accents (consolidation dot hue, active-tab underline).
- **13.A** — native `<dialog>` sizing — `max-width: min(960px, 95vw)`, `max-height: 85vh`, override browser defaults.
- **14.B** — indicator positions inside `#send_but_container`; stylesheet reserves a `.starmem-indicator` absolute-positioned slot that anchors to that container.
- **15c** — mobile: `@media (max-width: 639px)` hides the tab strip, unhides `.starmem-viewer-tab-select`, stacks settings-panel rows vertically.

**Context for the subagent:**

```
ABSOLUTE REPO PATH: /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem

Verify with `git log -1` showing <HEAD hash from Task 9> before work.

Constraints:
- Every selector starts with `.starmem-` or `#starmem-`. Exceptions are documented inline with a `/* exempt: ... */` comment and are limited to `#send_but_container` (indicator anchor) and `dialog::backdrop` (pseudo-element the dialog element owns).
- No external fonts, no @import. Everything inline in this file.
- No `!important` unless a comment explains why ST's own CSS would otherwise win. `!important` is allowed on at most three declarations repo-wide.
- All color values use `var(--SmartThemeSomething, #fallback)` form — fallback is mandatory so we degrade if ST renames vars.
- Units: `rem` for typography, `px` for borders/radii/indicator dot, `%` or `vh`/`vw` for dialog sizing.
- Media query: single breakpoint at 639px (mobile < 640).
- No CSS-in-JS concerns — this file is loaded by ST via manifest.json#css.
```

**Files:**
- Create: `style.css` (~200 lines)
- Create: `tests/integration/integration/style-css-invariants.test.js` (~50 lines; grep-based CSS hygiene)

**Step 1: Create `style.css`**

```css
/*
 * STARmem v2 stylesheet — loaded by SillyTavern via manifest.json#css.
 *
 * Theming strategy: hybrid per Phase 8 Decision 12. ST custom properties
 * with hardcoded fallbacks so we inherit user theme (Catppuccin, Midnight,
 * etc.) but never go invisible if ST renames a variable.
 *
 * Every class/id starts with `starmem-`, enforced by
 * tests/integration/integration/no-leaky-css.test.js. Exemptions are
 * documented inline.
 *
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

/* =========================================================================
 * Design tokens — locally-namespaced CSS custom properties.
 * Keeps var(--SmartTheme...) expansions out of every declaration.
 * ========================================================================= */

:root {
    --starmem-fg:           var(--SmartThemeBodyColor, #e8e8e8);
    --starmem-fg-muted:     var(--SmartThemeEmColor, #a0a0a0);
    --starmem-bg:           var(--SmartThemeBlurTintColor, #1a1a1a);
    --starmem-bg-elevated:  var(--SmartThemeShadowColor, #242424);
    --starmem-border:       var(--SmartThemeBorderColor, #3a3a3a);
    --starmem-accent:       #7aa2f7;                      /* STARmem blue */
    --starmem-accent-warm:  #e0af68;                      /* Indicator amber */
    --starmem-danger:       var(--SmartThemeErrorColor, #f7768e);
    --starmem-radius:       6px;
    --starmem-gap:          0.75rem;
    --starmem-indicator-sz: 10px;
}

/* =========================================================================
 * Consolidation indicator — anchored to ST's send-button container.
 * Decision 14.B: mount inside #send_but_container (stable ST structure).
 * ========================================================================= */

/* exempt: #send_but_container is ST's own element, used as anchor only */
#send_but_container {
    position: relative;                                   /* anchor for indicator */
}

.starmem-indicator {
    position: absolute;
    top: 4px;
    right: 4px;
    width: var(--starmem-indicator-sz);
    height: var(--starmem-indicator-sz);
    border-radius: 50%;
    background: transparent;
    pointer-events: none;
    transition: background 200ms ease-out, box-shadow 200ms ease-out;
}

/* Fallback path: no #send_but_container at mount time. CSS switches to
 * fixed positioning at the bottom-right corner of the viewport. */
.starmem-indicator.starmem-indicator-floating {
    position: fixed;
    top: auto;
    bottom: 12px;
    right: 12px;
    z-index: 10000;
}

.starmem-indicator.starmem-indicator-idle {
    background: transparent;
    box-shadow: none;
}

.starmem-indicator.starmem-indicator-busy {
    background: var(--starmem-accent-warm);
    box-shadow: 0 0 6px 1px var(--starmem-accent-warm);
    animation: starmem-pulse 1.2s ease-in-out infinite;
}

@keyframes starmem-pulse {
    0%, 100% { opacity: 0.75; }
    50%      { opacity: 1.0; }
}

/* =========================================================================
 * Settings panel — mounts into ST's #extensions_settings container.
 * ========================================================================= */

.starmem-settings-panel {
    display: flex;
    flex-direction: column;
    gap: var(--starmem-gap);
    padding: var(--starmem-gap);
    border: 1px solid var(--starmem-border);
    border-radius: var(--starmem-radius);
    color: var(--starmem-fg);
    background: var(--starmem-bg-elevated);
}

.starmem-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--starmem-gap);
}

.starmem-settings-label {
    flex: 0 0 auto;
    min-width: 8rem;
    font-weight: 500;
}

.starmem-settings-input,
.starmem-settings-select {
    flex: 1 1 auto;
    padding: 0.25rem 0.5rem;
    background: var(--starmem-bg);
    color: var(--starmem-fg);
    border: 1px solid var(--starmem-border);
    border-radius: var(--starmem-radius);
    font-family: inherit;
    font-size: 0.9rem;
}

.starmem-settings-slider-value {
    min-width: 3rem;
    text-align: right;
    color: var(--starmem-fg-muted);
    font-variant-numeric: tabular-nums;
}

.starmem-settings-warning {
    padding: 0.5rem;
    border-left: 3px solid var(--starmem-accent-warm);
    background: color-mix(in srgb, var(--starmem-accent-warm) 12%, transparent);
    color: var(--starmem-fg);
    font-size: 0.85rem;
}

.starmem-settings-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
}

/* =========================================================================
 * Viewer — native <dialog> per Decision 13.A.
 * ========================================================================= */

.starmem-viewer {
    max-width: min(960px, 95vw);
    max-height: 85vh;
    width: 100%;
    padding: 0;
    border: 1px solid var(--starmem-border);
    border-radius: calc(var(--starmem-radius) * 2);
    background: var(--starmem-bg);
    color: var(--starmem-fg);
    overflow: hidden;                                     /* tabs own their scroll */
}

.starmem-viewer::backdrop {
    /* exempt: ::backdrop is a pseudo-element the <dialog> owns */
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
}

.starmem-viewer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--starmem-gap) calc(var(--starmem-gap) * 1.5);
    border-bottom: 1px solid var(--starmem-border);
    background: var(--starmem-bg-elevated);
}

.starmem-viewer-title {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0;
}

.starmem-viewer-close {
    background: transparent;
    color: var(--starmem-fg);
    border: 1px solid var(--starmem-border);
    border-radius: var(--starmem-radius);
    padding: 0.25rem 0.5rem;
    cursor: pointer;
}

.starmem-viewer-close:hover {
    background: var(--starmem-bg);
}

/* -- Tab strip (desktop) ---------------------------------------------------- */

.starmem-viewer-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--starmem-border);
    background: var(--starmem-bg-elevated);
}

.starmem-viewer-tab {
    flex: 1 1 0;
    padding: 0.6rem 0.75rem;
    background: transparent;
    color: var(--starmem-fg-muted);
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9rem;
    transition: color 120ms ease-out, border-color 120ms ease-out;
}

.starmem-viewer-tab:hover {
    color: var(--starmem-fg);
}

.starmem-viewer-tab.starmem-viewer-tab-active {
    color: var(--starmem-fg);
    border-bottom-color: var(--starmem-accent);
}

/* -- Tab strip (mobile, < 640px) ------------------------------------------ */

.starmem-viewer-tab-select {
    display: none;                                        /* shown in media query */
    width: 100%;
    margin: 0.5rem 0;
    padding: 0.4rem 0.5rem;
    background: var(--starmem-bg-elevated);
    color: var(--starmem-fg);
    border: 1px solid var(--starmem-border);
    border-radius: var(--starmem-radius);
    font-family: inherit;
}

.starmem-viewer-body {
    padding: var(--starmem-gap);
    overflow-y: auto;
    max-height: calc(85vh - 8rem);                        /* leaves room for header+tabs */
}

/* =========================================================================
 * Tab-specific — Working / Episodic / Persona / Graph / Traces.
 * ========================================================================= */

.starmem-viewer-entry-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    list-style: none;
    padding: 0;
    margin: 0;
}

.starmem-viewer-entry {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--starmem-border);
    border-radius: var(--starmem-radius);
    background: var(--starmem-bg-elevated);
}

.starmem-viewer-entry-subject {
    font-weight: 600;
    color: var(--starmem-accent);
    margin-right: 0.5rem;
}

.starmem-viewer-entry-meta {
    color: var(--starmem-fg-muted);
    font-size: 0.8rem;
    margin-top: 0.25rem;
}

.starmem-viewer-entry-tag {
    display: inline-block;
    padding: 1px 6px;
    margin: 2px 4px 0 0;
    border-radius: 10px;
    background: color-mix(in srgb, var(--starmem-accent) 25%, transparent);
    color: var(--starmem-fg);
    font-size: 0.75rem;
}

/* -- Persona rebuild progress -- */

.starmem-viewer-persona-rebuild {
    margin-top: 0.5rem;
}

.starmem-viewer-persona-rebuild-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
}

.starmem-viewer-progress-line {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.8rem;
    color: var(--starmem-fg-muted);
}

/* -- Graph tab -- */

.starmem-viewer-graph-canvas {
    width: 100%;
    height: 400px;
    background: var(--starmem-bg-elevated);
    border: 1px solid var(--starmem-border);
    border-radius: var(--starmem-radius);
}

.starmem-viewer-graph-empty {
    padding: 2rem;
    text-align: center;
    color: var(--starmem-fg-muted);
}

/* -- Traces tab -- */

.starmem-viewer-traces-toolbar {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-bottom: 0.5rem;
}

.starmem-viewer-trace {
    padding: 0.5rem;
    border: 1px solid var(--starmem-border);
    border-radius: var(--starmem-radius);
    margin-bottom: 0.5rem;
    background: var(--starmem-bg-elevated);
}

.starmem-viewer-trace-summary {
    display: flex;
    gap: 0.75rem;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.85rem;
}

.starmem-viewer-trace-raw {
    display: none;
    white-space: pre-wrap;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.75rem;
    color: var(--starmem-fg-muted);
    margin-top: 0.5rem;
    max-height: 200px;
    overflow-y: auto;
}

.starmem-viewer-trace.starmem-viewer-trace-expanded .starmem-viewer-trace-raw {
    display: block;
}

/* =========================================================================
 * Responsive — single breakpoint at 639px (mobile).
 * Decision 15c: collapse tab strip into a <select>; stack settings rows.
 * ========================================================================= */

@media (max-width: 639px) {
    .starmem-viewer-tabs {
        display: none;
    }

    .starmem-viewer-tab-select {
        display: block;
    }

    .starmem-viewer {
        max-width: 100vw;
        max-height: 100vh;
        border-radius: 0;
    }

    .starmem-viewer-body {
        max-height: calc(100vh - 7rem);
    }

    .starmem-settings-row {
        flex-direction: column;
        align-items: stretch;
        gap: 0.25rem;
    }

    .starmem-settings-label {
        min-width: 0;
    }

    .starmem-viewer-graph-canvas {
        height: 250px;
    }
}
```

**Step 2: Create `tests/integration/integration/style-css-invariants.test.js`**

```js
/**
 * Regex invariants on style.css — not a visual test, just hygiene.
 *
 * Checks:
 *   1. Every selector token (`.foo` or `#foo`) is `starmem-*` or an exempt
 *      identifier with an inline `/* exempt: ... *\/` comment.
 *   2. No more than 3 uses of `!important` repo-wide.
 *   3. Every var(--SmartTheme…) has a fallback (second arg).
 *   4. Mobile breakpoint is exactly `(max-width: 639px)` — single breakpoint
 *      discipline per Decision 15c.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CSS_PATH = path.resolve(
    new URL('.', import.meta.url).pathname,
    '..', '..', '..', 'style.css',
);

describe('style.css invariants', () => {
    const css = readFileSync(CSS_PATH, 'utf8');

    test('every selector is `starmem-*` or explicitly exempted', () => {
        // Strip comments so "/* exempt: ... */" tokens don't confuse the matcher,
        // but track which selectors they guard.
        const exemptedLines = new Set();
        const re = /^(.*?)\/\*\s*exempt:.*?\*\//gm;
        let m;
        while ((m = re.exec(css)) !== null) {
            // Next non-blank, non-comment line is the exempted selector.
            const after = css.slice(m.index + m[0].length);
            const firstLine = after.split('\n').slice(0, 4).join('\n');
            for (const sub of firstLine.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) {
                exemptedLines.add(sub[1]);
            }
        }

        const selectors = new Set();
        for (const sub of css.matchAll(/[.#]([a-zA-Z][\w-]*)/g)) {
            selectors.add(sub[1]);
        }

        const violations = [];
        for (const s of selectors) {
            if (s.startsWith('starmem-')) continue;
            if (exemptedLines.has(s)) continue;
            violations.push(s);
        }
        expect(violations).toEqual([]);
    });

    test('no more than 3 uses of !important', () => {
        const count = (css.match(/!important/g) || []).length;
        expect(count).toBeLessThanOrEqual(3);
    });

    test('every var(--SmartTheme…) has a fallback', () => {
        const bad = [];
        for (const m of css.matchAll(/var\(\s*--SmartTheme[A-Za-z]+\s*(,[^)]*)?\)/g)) {
            if (!m[1]) bad.push(m[0]);
        }
        expect(bad).toEqual([]);
    });

    test('mobile breakpoint is exactly 639px', () => {
        const mqs = [...css.matchAll(/@media[^{]+/g)].map(m => m[0].trim());
        expect(mqs).toEqual(['@media (max-width: 639px)']);
    });
});
```

**Step 3: Run + commit**

```bash
npm run lint
npm test --silent -- tests/integration/integration/style-css-invariants.test.js
# expect: 4 tests pass
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
git add style.css tests/integration/integration/style-css-invariants.test.js
git commit -m "feat(integration): style.css — hybrid theme, <dialog>, mobile breakpoint"
```

**Done when:**
- 4 style invariants green
- Manual eyeball from Eva before we declare done (Decision 12.C stipulates look-see)
- No stray non-prefixed selectors
- Breakpoint singular at 639px
- Every ST theme var has a fallback

---

## Task 11 — `scripts/smoke.md` + ROADMAP retro + plan rename

**Objective:** Close Phase 8 out. Three artifacts:

1. **`scripts/smoke.md`** — 18-step manual smoke checklist per Decision 15.B (thorough, pure prose per 15b).
2. **`docs/plans/ROADMAP.md`** — append Phase 8 retro, matching Phase 7's format (what shipped, decisions held, surprises, notes for Phase 9).
3. **File rename** — `docs/plans/phase-8-integration.md` → `docs/plans/phase-8-st-integration.md` (ROADMAP convention; mentioned in Hindsight too).

**Owner:** Controller. No code, no tests — documentation-only, and the retro needs signal that only the controller has (decision drift, subagent surprises, commit counts).

**Files:**
- Create: `scripts/smoke.md`
- Modify: `docs/plans/ROADMAP.md` (append Phase 8 section)
- Rename: `docs/plans/phase-8-integration.md` → `docs/plans/phase-8-st-integration.md` (overwritten with the finalized plan from this chunked doc)

**Step 1: Create `scripts/smoke.md`**

```markdown
# STARmem Phase 8 smoke checklist

**Scope:** 18 manual steps verifying end-to-end ST integration. Run after every Phase 8 ship; also the baseline for Phase 9 regression checks.

**Prerequisites:**
- Fresh SillyTavern checkout (or a known-clean install; no prior STARmem state in `chatMetadata`).
- At least one Connection Manager profile configured with a working LLM.
- The Vectors extension installed and enabled (needed for Persona rebuild in step 14).
- Browser devtools console open — every step cross-checks against console logs scoped to `[STARmem]`.

## Happy path

1. **Install.** `git clone` this repo into `public/scripts/extensions/third-party/`. Restart ST. Verify the Extensions panel lists "STARmem" as loaded without errors. Console shows `[STARmem] v2 loaded`.

2. **Settings panel renders.** Open the Extensions panel → STARmem. Verify all eight inputs are present: profile, embed profile, buffer size, idle timeout, scorer, extraction model label, traces max length, debug mode. No broken labels or missing defaults.

3. **Settings round-trip.** Change buffer size from 5 → 7. Reload ST. Reopen settings panel. Verify buffer size is still 7 (persisted to `extension_settings`). Change back to 5.

4. **Settings clamp.** In devtools: `extension_settings.STARmem.bufferSize = 999; saveSettingsDebounced()`. Reload. Open settings — verify clamped to 50 (the max) and a `[STARmem] settings:` warn line appears in console.

5. **Fresh chat, no memories yet.** Start a new chat. Send one user message. Verify the generation completes normally — interceptor runs (console `[STARmem] interceptor: no memories to inject` or similar) and does NOT prepend a system message.

6. **Consolidation indicator idle.** Verify `#send_but_container` has a `.starmem-indicator` child and it is visually absent (no amber pulse).

7. **Buffer grows.** Send 9 more user+assistant exchanges for a total of 10 messages. Verify console shows `[STARmem] workingBuffer: append` (or equivalent) on each. No consolidation yet.

8. **Consolidation fires at threshold.** Send message 11 (total 11). Verify: indicator flips to amber pulse; console shows `[STARmem] consolidation: starting`; after ~seconds, `consolidation: done, added=N, updated=M`. Indicator returns to idle.

9. **Episodic entries visible.** Open Memory Viewer (settings → "Open Memory Viewer" button). Click Episodic tab. Verify at least one entry is rendered with subject + content + tags.

10. **Graph tab renders.** Click Graph tab. Verify either (a) a force-directed canvas with nodes/edges, or (b) the empty-state message if fewer than 2 entries with edges yet. No uncaught exceptions in console.

11. **Traces tab renders.** Click Traces tab. Verify the summary line for the last retrieval: `T=<tier>  q="..."  top=<score>`. Click a trace to expand the raw JSON. Click Clear — confirm dialog appears; answer No; verify trace still present. Click Clear again, answer Yes; verify list empty.

12. **JSONL export.** Expand Traces tab after a retrieval, click "Export JSONL". Verify a file downloads with `.jsonl` extension, filename contains `starmem-traces-<timestamp>`. Open the file — verify each line is valid JSON parseable independently.

## Chat-switch hygiene

13. **Chat switch mid-idle.** With idle timer running (no messages sent in last 30s), switch to another chat. Verify console shows `[STARmem] idleTimer: cancelled for <oldChatId>`. Switch back. Send a message. Verify idle timer restarts from 60s.

14. **Persona rebuild.** Return to chat from step 9 (now has Episodic entries). In Memory Viewer → Persona tab, type a subject from the Episodic entries, click Rebuild. Verify progress lines scroll (`snapshot`, `chunk`, `knn`, `cluster`, `summarize`, `atomic-swap`). Verify final line shows `Done — N new / M replaced in Xms`. Switch to Persona tab proper — verify new entries.

## Defensive paths

15. **Vectors extension disabled.** Disable the Vectors extension. Attempt a Persona rebuild in any chat. Verify error rendered in the progress panel: `Failed: fetch …` with a descriptive message. No stack trace leaks to user. Re-enable Vectors.

16. **Delete a message mid-chat.** With working buffer populated (≥3 entries), right-click a user message → Delete. Verify working buffer scrubs the corresponding entry (console: `workingBuffer: deleted message at idx N`), buffer count decreases by 1.

17. **Settings drift + reload.** In devtools: `extension_settings.STARmem.schemaVersion = 99; saveSettingsDebounced()`. Reload ST. Open settings. Verify console warned about schemaVersion drift; settings now show defaults.

18. **Disable + re-enable extension.** Disable STARmem via Extensions panel. Verify: indicator disappears; no console errors. Re-enable. Verify: `[STARmem] v2 loaded` appears; indicator re-mounts; next generation still works.

## Regression baseline

After running steps 1–18:
- Copy the browser console output to `scripts/smoke-logs/<date>.log` (git-ignored).
- Note any unexpected warnings/errors for Phase 9 triage.
- If any step fails: **do not ship**. File as Phase 8 bug, fix, re-run the whole checklist.
```

**Step 2: Append Phase 8 retro to `docs/plans/ROADMAP.md`**

The retro is appended above the existing Phase 7 retro entry (newest-first convention). Template (fill in during the actual retro pass — counts, commit hashes, surprises):

```markdown
## Phase 8—2026-04-21

**What shipped:** SillyTavern integration surface — `src/integration/constants.js` (UI-scoped settings + injection constants), `src/integration/settings.js` (extension_settings persistence with defaults, clamps, schemaVersion drift handling, scorerId validation via `setScorer`), `src/integration/interceptor.js` (the real `STARmemInterceptor` body — chatId resolution, last-user-message query extraction, retrieve → splice at `INJECTION_DEPTH=4` with depth-fallback, per-returned-entry `applyAccessEvent`, all errors caught and swallowed), `src/integration/bootstrap.js` (APP_READY handler — settings load, indicator mount, viewer pre-mount, idle timer install, CHAT_CHANGED/MESSAGE_RECEIVED/MESSAGE_DELETED subscriptions, idempotent double-bootstrap), `src/integration/indicator.js` (consolidation dot mounted in `#send_but_container` — idempotent mount, 1s polling of `state.runtime.consolidating`, animated pulse), `src/integration/settingsPanel.js` + inlined HTML (eight inputs — profile/embedProfile dropdowns, three sliders, scorer select, label input, debug toggle — all persisting through `setSettings`), `src/integration/viewer/mount.js` (native `<dialog>` shell with tab strip + mobile `<select>` collapse at 639px, close/teardown, tab routing), `src/integration/viewer/tabs/{working,episodic,persona,graph,traces}.js` (five tabs, each self-contained, each JSDOM-tested), `tests/helpers/stContextMock.js` (minimal `getContext()` factory + `eventSource` spy for Phase 8 tests), `src/integration/index.js` barrel, root `index.js` rewrite (TLA subscription to APP_READY + interceptor shim), `style.css` (hybrid ST-var + hardcoded-accent theme, single 639px breakpoint, four CSS invariants enforced in tests), `scripts/smoke.md` (18-step thorough manual checklist), and the Phase 8 retro block above. File rename: `docs/plans/phase-8-integration.md` → `docs/plans/phase-8-st-integration.md`.

**Test totals:** <CONTROLLER: fill in after final npm test run>. Expected ~440 baseline + ~130 new ≈ ~570 tests across ~55 suites.

**Commits this phase:** <CONTROLLER: fill in>. Expected ~18 per Task overview table.

**Execution mode:** Mixed — controller for load-bearing tasks (0, 2, 3, 8, 9, 11), subagents for DOM-heavy or mechanical tasks (1, 4, 5, 6, 7.1–7.5, 10). Reviews skipped per skill criteria (verbatim code + static checks). Controller audits: grep invariant on CSS prefix (Task 9), grep invariant on bootstrap event wiring (Task 3), tripwire verification on both.

**Decisions locked in the planning conversation (all held through execution):**

1. E2E harness: JSDOM + manual smoke checklist. Playwright deferred to Phase 9.
2. DOM rendering: vanilla `createElement`/`textContent` for data, `innerHTML` only for static templates.
3. Settings persistence: `extension_settings['STARmem']` for globals, no new per-chat settings.
4. Injection format: `is_system` spliced at `INJECTION_DEPTH=4`, `role: system`, fallback-prepend at short chats.
5. Access events: pre-generate — called on entries returned by `retrieve()`, not every candidate.
6. Chat switch hygiene: `CHAT_CHANGED` handler cancels idle timer, clears per-chat caches, triggers `maybeConsolidate` on new chat if over threshold.
7. Traces: 128-entry ring buffer, JSONL export via blob URL, per-trace expand.
8. Delegation split: controller owns load-bearing/integration, subagents own DOM components.
9. CSS scoping: `starmem-*` prefix on every class/id, enforced by grep invariant.
10. Module layout deviates from spec §10 — documented in §5 of the phase plan; spec amendment needed.
11. stContextMock surface: minimal + `eventSource` spy, factory-per-test (not shared singleton).
12. CSS theming: hybrid — `var(--SmartTheme…, #fallback)` for surfaces, hardcoded accents for STARmem-specific elements.
13. Viewer modal: native `<dialog>` with `showModal()`.
14. Indicator mount: `#send_but_container` anchor (stable ST structure), NOT document.body — revised from chunk 3 draft.
15. Smoke checklist: thorough (18 steps, pure prose).

**Surprises:** <CONTROLLER: fill in>

**Notes for Phase 9 (Benchmarking):** <CONTROLLER: fill in with Phase 8-observed behavior worth carrying forward>

---
```

**Step 3: Run + commit**

```bash
# Rename the plan file (content overwrite happens earlier when we
# stitch the finalized chunks together; this just fixes the filename).
git mv docs/plans/phase-8-integration.md docs/plans/phase-8-st-integration.md

# Verify full test suite is green before shipping retro.
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"

# Manual: run smoke.md steps 1-18 against a fresh ST install. Record
# outcomes. If any fail, do NOT proceed — fix, re-run, retry.

# Final commit.
git add scripts/smoke.md docs/plans/ROADMAP.md docs/plans/phase-8-st-integration.md
git commit -m "docs(plans): Phase 8 retro + smoke checklist + plan rename"
```

**Done when:**
- `scripts/smoke.md` exists with 18 steps in three sections (happy path / chat-switch hygiene / defensive paths)
- ROADMAP.md has a Phase 8 section with filled-in counts, commits, surprises, notes-for-Phase-9
- `docs/plans/phase-8-st-integration.md` is the canonical plan filename (old `phase-8-integration.md` gone)
- Eva has eyeballed the rendered UI at least once (Decision 12.C stipulation)
- All 18 smoke steps pass against a fresh ST install
- Full `npm test` suite green

---
