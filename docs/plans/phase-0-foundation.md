# Phase 0—Foundation: Implementation Plan

> **For Hermes:** Use `subagent-driven-development` skill to execute this plan task-by-task after Eva approves.

**Goal:** Get the repo buildable, testable, and ready for real code. Set up the dev loop (lint, type-check, unit tests, logger) so every later phase can rely on green CI-equivalent locally.

**Architecture:** No business logic. We ship tooling, a src/ tree matching spec §10, a constants file, a logger, and a smoke test. All three `npm run test|lint|typecheck` commands exit 0.

**Tech Stack:** Node 20+, ESM modules, jest (with `--experimental-vm-modules` for ESM), ESLint 9 flat config, TypeScript in JSDoc check-only mode (`checkJs: true`, `noEmit: true`).

---

## Task 0: Pre-flight

**Objective:** Verify Node/npm available and confirm starting state.

**Step 1:** Run `node --version` and `npm --version`. Expected: Node ≥20.x, npm ≥10.x.

**Step 2:** Run `cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem && git status`. Expected: `On branch main`, `working tree clean`.

**Step 3:** Confirm `docs/specs/2026-04-20-starmem-v2-design.md` exists.

**No commit.**

---

## Task 1: Populate devDependencies

**Objective:** Install the dev toolchain.

**Files:**
- Modify: `package.json`

**Step 1:** Overwrite `package.json` with:

```json
{
    "name": "starmem",
    "version": "2.0.0-dev",
    "description": "STARmem—deterministic memory for SillyTavern roleplay",
    "type": "module",
    "private": true,
    "scripts": {
        "typecheck": "tsc --noEmit",
        "lint": "eslint 'src/**/*.js' 'tests/**/*.js'",
        "lint:fix": "eslint 'src/**/*.js' 'tests/**/*.js' --fix",
        "test": "node --experimental-vm-modules node_modules/.bin/jest",
        "test:watch": "node --experimental-vm-modules node_modules/.bin/jest --watch",
        "test:coverage": "node --experimental-vm-modules node_modules/.bin/jest --coverage"
    },
    "devDependencies": {
        "@eslint/js": "^9.0.0",
        "eslint": "^9.0.0",
        "globals": "^15.0.0",
        "jest": "^29.7.0",
        "typescript": "^5.4.0"
    },
    "dependencies": {}
}
```

**Step 2:** `npm install`. Expected: completes without errors, `node_modules/` populated.

**Step 3:** Commit.

```bash
git add package.json package-lock.json
git commit -m "chore(foundation): install dev toolchain (eslint, jest, typescript)"
```

---

## Task 2: ESLint flat config

**Objective:** Set up ESLint 9 with sensible defaults.

**Files:**
- Create: `eslint.config.js`

**Step 1:** Write `eslint.config.js`:

```javascript
import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.jest,
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
            'prefer-const': 'error',
            'eqeqeq': ['error', 'smart'],
        },
    },
    {
        ignores: ['node_modules/', 'dist/', 'coverage/'],
    },
];
```

**Step 2:** Run `npm run lint`. Expected: exit 0 (no files to lint yet is not an error—eslint matches zero files gracefully).

**Step 3:** Commit.

```bash
git add eslint.config.js
git commit -m "chore(foundation): add eslint flat config"
```

---

## Task 3: TypeScript JSDoc-check config

**Objective:** Type-check JSDoc annotations without emitting any TS files.

**Files:**
- Create: `tsconfig.json`

**Step 1:** Write `tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "allowJs": true,
        "checkJs": true,
        "noEmit": true,
        "strict": false,
        "noImplicitAny": false,
        "noUnusedLocals": false,
        "noUnusedParameters": false,
        "skipLibCheck": true,
        "esModuleInterop": true,
        "resolveJsonModule": true
    },
    "include": ["src/**/*.js", "tests/**/*.js"],
    "exclude": ["node_modules", "dist", "coverage"]
}
```

**Step 2:** Run `npm run typecheck`. Expected: exit 0 (no files matched yet).

**Step 3:** Commit.

```bash
git add tsconfig.json
git commit -m "chore(foundation): add tsconfig for JSDoc type-checking"
```

---

## Task 4: Jest config

**Objective:** Jest with ESM support.

**Files:**
- Create: `jest.config.js`

**Step 1:** Write `jest.config.js`:

```javascript
export default {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    transform: {},
    moduleFileExtensions: ['js', 'mjs'],
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/**/index.js',
    ],
    coverageDirectory: 'coverage',
};
```

**Step 2:** Run `npm run test`. Expected: exits with "No tests found"—this is OK for now. The command runs without crashing.

**Step 3:** Commit.

```bash
git add jest.config.js
git commit -m "chore(foundation): add jest config with ESM support"
```

---

## Task 5: Create empty src/ tree

**Objective:** Match spec §10 layout. Each directory gets a `.gitkeep` so git tracks it.

**Files:**
- Create: `src/core/.gitkeep`
- Create: `src/retrieval/.gitkeep`
- Create: `src/memory/.gitkeep`
- Create: `src/lifecycle/.gitkeep`
- Create: `src/consolidation/.gitkeep`
- Create: `src/integration/.gitkeep`
- Create: `src/eval/.gitkeep`
- Create: `tests/unit/.gitkeep`
- Create: `tests/integration/.gitkeep`

**Step 1:** Use terminal to create all dirs and gitkeep files:

```bash
for d in src/core src/retrieval src/memory src/lifecycle src/consolidation src/integration src/eval tests/unit tests/integration; do
    mkdir -p "$d"
    touch "$d/.gitkeep"
done
```

**Step 2:** Verify with `find src tests -type d -not -name 'node_modules' | sort`. Expected: 9 directories.

**Step 3:** Commit.

```bash
git add src/ tests/
git commit -m "chore(foundation): scaffold src/ and tests/ layout per spec §10"
```

---

## Task 6: Core constants

**Objective:** Centralize spec-derived constants. Any number that appears twice in the spec gets a name.

**Files:**
- Create: `src/core/constants.js`
- Test: `tests/unit/core/constants.test.js`

**Step 1:** Write the failing test first (`tests/unit/core/constants.test.js`):

```javascript
import {
    SCOPES,
    EDGE_TYPES,
    QUERY_INTENTS,
    MATURITY_TIERS,
    LIFECYCLE,
    RETRIEVAL,
    CONSOLIDATION,
    TRACE_BUFFER_CAP,
} from '../../../src/core/constants.js';

describe('constants', () => {
    test('SCOPES has the three spec §4 scopes', () => {
        expect(SCOPES).toEqual(['working', 'episodic', 'persona']);
    });

    test('EDGE_TYPES has four produced types; contradicts is reserved', () => {
        expect(EDGE_TYPES.PRODUCED).toEqual([
            'mentions', 'supports', 'same_topic', 'temporal_next',
        ]);
        expect(EDGE_TYPES.RESERVED).toEqual(['contradicts']);
    });

    test('QUERY_INTENTS is the 3-type classifier set', () => {
        expect(QUERY_INTENTS).toEqual(['factual', 'relational', 'temporal']);
    });

    test('MATURITY_TIERS matches spec §7', () => {
        expect(MATURITY_TIERS).toEqual(['draft', 'validated', 'core']);
    });

    test('LIFECYCLE constants match spec §7 verbatim', () => {
        expect(LIFECYCLE.ACCESS_BONUS).toBe(3);
        expect(LIFECYCLE.UPDATE_BONUS).toBe(5);
        expect(LIFECYCLE.DAILY_DECAY).toBe(0.995);
        expect(LIFECYCLE.RECENCY_TAU_DAYS).toBe(30);
        expect(LIFECYCLE.MATURITY_BOOST).toEqual({
            draft: 0.85,
            validated: 1.0,
            core: 1.2,
        });
        expect(LIFECYCLE.PROMOTION.draftToValidated).toBe(65);
        expect(LIFECYCLE.DEMOTION.validatedToDraft).toBe(35);
        expect(LIFECYCLE.PROMOTION.validatedToCore).toBe(85);
        expect(LIFECYCLE.DEMOTION.coreToValidated).toBe(60);
    });

    test('RETRIEVAL thresholds match spec §5', () => {
        expect(RETRIEVAL.FUZZY_JACCARD_THRESHOLD).toBe(0.6);
        expect(RETRIEVAL.TIER3_LAMBDA_1).toBe(1.0);
        expect(RETRIEVAL.TIER3_LAMBDA_2).toBe(0.3);
        expect(RETRIEVAL.TIER3_MAX_HOPS).toBe(2);
    });

    test('CONSOLIDATION defaults match spec §6', () => {
        expect(CONSOLIDATION.WORKING_BUFFER_THRESHOLD).toBe(10);
        expect(CONSOLIDATION.IDLE_TRIGGER_SECONDS).toBe(60);
        expect(CONSOLIDATION.BATCH_SIZE).toBe(5);
        expect(CONSOLIDATION.PERSONA_REBUILD_SUGGESTION_THRESHOLD).toBe(100);
    });

    test('TRACE_BUFFER_CAP matches spec §9.1', () => {
        expect(TRACE_BUFFER_CAP).toBe(100);
    });
});
```

**Step 2:** Run `npm run test tests/unit/core/constants.test.js`. Expected: FAIL with "Cannot find module '.../constants.js'".

**Step 3:** Write `src/core/constants.js`:

```javascript
/**
 * STARmem core constants—single source of truth for spec-derived values.
 * Any number referenced by the spec more than once lives here.
 *
 * @module core/constants
 * @see docs/specs/2026-04-20-starmem-v2-design.md
 */

/** Memory scopes. Spec §4. */
export const SCOPES = Object.freeze(['working', 'episodic', 'persona']);

/** Edge types. Spec §4. `contradicts` is reserved but not emitted in v2.0. */
export const EDGE_TYPES = Object.freeze({
    PRODUCED: Object.freeze(['mentions', 'supports', 'same_topic', 'temporal_next']),
    RESERVED: Object.freeze(['contradicts']),
});

/** Query classifier intents. Spec §5 (3-type classifier). */
export const QUERY_INTENTS = Object.freeze(['factual', 'relational', 'temporal']);

/** Maturity tiers. Spec §7. */
export const MATURITY_TIERS = Object.freeze(['draft', 'validated', 'core']);

/** Lifecycle math constants. Spec §7, verbatim from ByteRover's AKL. */
export const LIFECYCLE = Object.freeze({
    /** Importance bonus on access. Spec §7. */
    ACCESS_BONUS: 3,
    /** Importance bonus on update. Spec §7. */
    UPDATE_BONUS: 5,
    /** Daily decay multiplier (~0.5% daily). Spec §7. */
    DAILY_DECAY: 0.995,
    /** Recency decay time constant in days (~21-day half-life). Spec §7. */
    RECENCY_TAU_DAYS: 30,
    /** Retrieval score multipliers per maturity tier. Spec §5.2 / §7. */
    MATURITY_BOOST: Object.freeze({
        draft: 0.85,
        validated: 1.0,
        core: 1.2,
    }),
    /** Promotion thresholds (hysteresis). Spec §7. */
    PROMOTION: Object.freeze({
        draftToValidated: 65,
        validatedToCore: 85,
    }),
    /** Demotion thresholds (hysteresis gaps). Spec §7. */
    DEMOTION: Object.freeze({
        validatedToDraft: 35,
        coreToValidated: 60,
    }),
});

/** Retrieval ladder constants. Spec §5, §5.1, §5.2. */
export const RETRIEVAL = Object.freeze({
    /** Tier 1 fuzzy-match Jaccard threshold. Spec §5. */
    FUZZY_JACCARD_THRESHOLD: 0.6,
    /** Tier 3 beam-search weights. Spec §5.1. */
    TIER3_LAMBDA_1: 1.0,
    TIER3_LAMBDA_2: 0.3,
    /** Tier 3 max hops. Spec §5.1. */
    TIER3_MAX_HOPS: 2,
});

/** Consolidation trigger thresholds. Spec §6.2, §6.3, §6.4. */
export const CONSOLIDATION = Object.freeze({
    /** Working buffer size that triggers consolidation. Spec §6.2. */
    WORKING_BUFFER_THRESHOLD: 10,
    /** User-idle seconds that trigger consolidation. Spec §6.2. */
    IDLE_TRIGGER_SECONDS: 60,
    /** Messages drained from working buffer per consolidation batch. Spec §6.3. */
    BATCH_SIZE: 5,
    /** Episodic entries added before suggesting a Persona rebuild. Spec §6.4. */
    PERSONA_REBUILD_SUGGESTION_THRESHOLD: 100,
});

/** Trace ring buffer cap. Spec §9.1. */
export const TRACE_BUFFER_CAP = 100;
```

**Step 4:** Run `npm run test tests/unit/core/constants.test.js`. Expected: all 7 tests PASS.

**Step 5:** Run `npm run lint` and `npm run typecheck`. Expected: both exit 0.

**Step 6:** Commit.

```bash
git add src/core/constants.js tests/unit/core/constants.test.js
git commit -m "feat(core): add spec-derived constants with golden-value tests"
```

---

## Task 7: Structured logger

**Objective:** A single `logger` module that respects ST's debug flag and has a consistent prefix. All later code uses this, never bare `console.log`.

**Files:**
- Create: `src/core/logger.js`
- Test: `tests/unit/core/logger.test.js`

**Step 1:** Write the failing test:

```javascript
import { createLogger } from '../../../src/core/logger.js';

describe('logger', () => {
    let calls;
    let fakeConsole;

    beforeEach(() => {
        calls = { log: [], warn: [], error: [], debug: [] };
        fakeConsole = {
            log: (...args) => calls.log.push(args),
            warn: (...args) => calls.warn.push(args),
            error: (...args) => calls.error.push(args),
            debug: (...args) => calls.debug.push(args),
        };
    });

    test('info prefixes messages with [STARmem]', () => {
        const log = createLogger({ console: fakeConsole, debug: false });
        log.info('hello');
        expect(calls.log).toHaveLength(1);
        expect(calls.log[0][0]).toBe('[STARmem]');
        expect(calls.log[0][1]).toBe('hello');
    });

    test('debug is silent when debug flag is false', () => {
        const log = createLogger({ console: fakeConsole, debug: false });
        log.debug('hidden');
        expect(calls.debug).toHaveLength(0);
    });

    test('debug logs when debug flag is true', () => {
        const log = createLogger({ console: fakeConsole, debug: true });
        log.debug('visible');
        expect(calls.debug).toHaveLength(1);
        expect(calls.debug[0][0]).toBe('[STARmem:debug]');
    });

    test('scoped logger appends scope to prefix', () => {
        const log = createLogger({ console: fakeConsole, debug: false });
        const scoped = log.scope('retrieval');
        scoped.info('msg');
        expect(calls.log[0][0]).toBe('[STARmem:retrieval]');
    });

    test('warn and error always fire regardless of debug flag', () => {
        const log = createLogger({ console: fakeConsole, debug: false });
        log.warn('w');
        log.error('e');
        expect(calls.warn).toHaveLength(1);
        expect(calls.error).toHaveLength(1);
    });
});
```

**Step 2:** Run it. Expected: FAIL ("Cannot find module").

**Step 3:** Write `src/core/logger.js`:

```javascript
/**
 * STARmem structured logger. All STARmem code should use this instead of
 * bare console.* calls. Prefix is stable; debug channel is gated by a flag.
 *
 * @module core/logger
 */

/**
 * @typedef {object} LoggerOptions
 * @property {Console} [console] - Injectable console for testing.
 * @property {boolean} [debug] - If true, debug() calls reach the console.
 */

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 * @property {(...args: unknown[]) => void} debug
 * @property {(scope: string) => Logger} scope - Returns a child logger with scope appended to prefix.
 */

/**
 * Create a STARmem logger.
 *
 * @param {LoggerOptions} [opts]
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
    const _console = opts.console ?? globalThis.console;
    const debug = Boolean(opts.debug);
    return makeLogger(_console, debug, 'STARmem');
}

function makeLogger(_console, debug, prefix) {
    return {
        info: (...args) => _console.log(`[${prefix}]`, ...args),
        warn: (...args) => _console.warn(`[${prefix}]`, ...args),
        error: (...args) => _console.error(`[${prefix}]`, ...args),
        debug: (...args) => {
            if (debug) _console.debug(`[${prefix}:debug]`, ...args);
        },
        scope: (name) => makeLogger(_console, debug, `${prefix}:${name}`),
    };
}

/** Default module-level logger; debug off by default, flip via settings later. */
export const log = createLogger({ debug: false });
```

**Step 4:** Run `npm run test tests/unit/core/logger.test.js`. Expected: all 5 tests PASS.

**Step 5:** Run `npm run lint` and `npm run typecheck`. Expected: both exit 0.

**Step 6:** Commit.

```bash
git add src/core/logger.js tests/unit/core/logger.test.js
git commit -m "feat(core): add structured logger with scoped children and debug gate"
```

---

## Task 8: Wire index.js to use the logger

**Objective:** Replace the bare `console.log` in `index.js` with the new logger; keep the interceptor stub.

**Files:**
- Modify: `index.js`

**Step 1:** Overwrite `index.js`:

```javascript
/**
 * STARmem—SillyTavern memory extension (v2).
 *
 * Entry point. Registers the generate_interceptor and wires up
 * initialization on APP_READY. Most logic lives under src/.
 *
 * @see docs/specs/2026-04-20-starmem-v2-design.md
 */

import { log } from './src/core/logger.js';

// TODO(impl): import { eventSource, event_types } from '../../../../script.js';
// TODO(impl): import { extension_settings } from '../../../extensions.js';
// TODO(impl): wire init → initSTARmem() on APP_READY.

/**
 * Generate interceptor—registered via manifest.json#generate_interceptor.
 * Called by SillyTavern before each generation with the full chat history.
 *
 * @param {Array} chat - Full conversation history array.
 * @param {number} contextSize - Available context size.
 * @param {Function} abort - Call to abort generation.
 * @param {string} type - Generation type.
 * @returns {Promise<void>}
 */
// eslint-disable-next-line no-unused-vars
globalThis.STARmemInterceptor = async function STARmemInterceptor(chat, contextSize, abort, type) {
    // Implementation pending—see docs/plans/.
};

log.info('v2 loaded (scaffold only)');
```

**Step 2:** Run `npm run lint` and `npm run typecheck`. Expected: both exit 0.

**Step 3:** Commit.

```bash
git add index.js
git commit -m "refactor(entry): use structured logger in index.js"
```

---

## Task 9: Phase 0 verification

**Objective:** Prove the whole dev loop is green before declaring Phase 0 done.

**Step 1:** Run all three checks in sequence:

```bash
npm run lint && npm run typecheck && npm run test
```

Expected:
- `lint`: exit 0
- `typecheck`: exit 0
- `test`: all tests pass, exit 0

**Step 2:** Run `git log --oneline`. Expected: 8 new commits from this phase.

**Step 3:** Run `git status`. Expected: working tree clean.

**No commit.**

---

## Task 10: Append Phase 0 retro to ROADMAP

**Objective:** Record what was easy, what surprised us, what should change for Phase 1's plan.

**Files:**
- Modify: `docs/plans/ROADMAP.md`

**Step 1:** Append to Section 6 "Phase Retro Log":

```markdown
## Phase 0—<YYYY-MM-DD>

**What shipped:** dev toolchain (eslint 9 flat config, jest ESM, tsc JSDoc mode), empty `src/` tree per spec §10, `constants.js` with golden-value tests, structured logger with scoped children, `index.js` wired to logger.

**Surprises:** <fill in after completion>

**Notes for Phase 1:** <fill in after completion—especially anything that changed from the inter-phase contract in the roadmap>
```

**Step 2:** Commit.

```bash
git add docs/plans/ROADMAP.md
git commit -m "docs(plans): Phase 0 retro"
```

---

## Phase 0 Done-When (final check)

- [ ] `npm run lint` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm run test` exits 0 with 12 passing tests (7 constants + 5 logger)
- [ ] `git log --oneline` shows 9 commits on main beyond the initial scaffold
- [ ] `git status` clean
- [ ] Working tree matches the `src/` layout in spec §10
- [ ] Every constant referenced by the spec more than once is in `constants.js`
- [ ] Every `console.*` call in STARmem code has been replaced with `log.*`
- [ ] Phase 0 retro appended to ROADMAP

**Total commits this phase:** 9 (Tasks 1–8 each commit once, Task 10 commits).
