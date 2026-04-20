# Phase 1—Storage: Implementation Plan

> **For Hermes:** Use `subagent-driven-development` to execute this plan task-by-task after Eva approves. Each task is 2-5 minutes of focused work; fresh subagent per task with spec-compliance review then code-quality review.

**Goal:** Land the persistence layer. By the end, we can build an entry, validate it, create an empty State, persist it through an injectable ST-backed store, read it back, and guarantee mutual exclusion on writes via a per-chat async mutex. No retrieval yet; no business logic yet.

**Architecture:** Four modules—`core/schema.js` (types + validators + `createEmptyState`), `memory/entry.js` (`createEntry`, `isValidEntry`), `core/lock.js` (per-chat async mutex), `core/state.js` (`loadState`/`persistState` with injectable backend). Backend injection lets unit tests substitute an in-memory Map for ST's `chat_metadata`. In browser runtime, the default backend reads `globalThis.chat_metadata['STARmem']` and calls `saveMetadataDebounced()`.

**Tech Stack:** Same as Phase 0—Node 20+, ESM, jest w/ `--experimental-vm-modules`, ESLint 9 flat, tsc JSDoc check-only. No new devDependencies. No runtime deps (per §10 policy).

**Spec references:** §2 principle 2 (one write path, single mutator), §3.1 (entry schema), §3.2 (top-level state).

---

## Task 0: Pre-flight

**Objective:** Confirm clean starting state from Phase 0.

**Step 1:** `cd ~/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem && git status`. Expected: `On branch main`, clean tree, last commit `docs(plans): Phase 0 retro`.

**Step 2:** `npm run lint && npm run typecheck && npm run test`. Expected: all three exit 0, 13 tests pass (from Phase 0).

**Step 3:** Confirm `src/core/constants.js`, `src/core/logger.js`, `src/memory/.gitkeep` exist. No commit.

---

## Task 1: Entry schema — JSDoc typedefs and enums

**Objective:** Land `src/core/schema.js` with the `Entry`, `Lifecycle`, `Relation`, `Provenance`, `State`, `Edge` typedefs. No logic yet—types and small frozen enum helpers only. This file is imported by every later module in the phase; isolating it to one task keeps review tight.

**Files:**
- Create: `src/core/schema.js`

**Step 1:** Write `src/core/schema.js`:

```javascript
/**
 * STARmem schema—JSDoc types for the persisted state tree.
 * Runtime helpers are limited to frozen enums and tier-union constants.
 * Validators live alongside the factories that produce each shape
 * (see `src/memory/entry.js` for `isValidEntry`; see `createEmptyState`
 * in this module for the top-level state).
 *
 * @module core/schema
 * @see docs/specs/2026-04-20-starmem-v2-design.md §3
 */

import { SCOPES, EDGE_TYPES, MATURITY_TIERS } from './constants.js';

/**
 * @typedef {'working' | 'episodic' | 'persona'} Scope
 */

/**
 * @typedef {'draft' | 'validated' | 'core'} Maturity
 */

/**
 * @typedef {'mentions' | 'supports' | 'same_topic' | 'temporal_next' | 'contradicts'} EdgeType
 */

/**
 * @typedef {object} Relation
 * @property {EdgeType} type
 * @property {string} target  - Entry id this relation points at.
 */

/**
 * @typedef {object} Lifecycle
 * @property {number} importance    - [0, 100]; see spec §7.
 * @property {Maturity} maturity
 * @property {string} createdAt     - ISO 8601 timestamp.
 * @property {string} updatedAt     - ISO 8601 timestamp.
 * @property {number} accessCount
 * @property {number} updateCount
 */

/**
 * @typedef {object} Provenance
 * @property {number[]} sourceMessages  - Indices into the ST chat array.
 * @property {string} extractor         - e.g. "gemma-4-31b@consolidation-v1".
 */

/**
 * @typedef {object} Entry
 * @property {string} id
 * @property {Scope} scope
 * @property {string} content
 * @property {string | null} subject
 * @property {string[]} tags
 * @property {Relation[]} relations
 * @property {Lifecycle} lifecycle
 * @property {Provenance} provenance
 */

/**
 * @typedef {object} Edge
 * @property {string} from
 * @property {string} to
 * @property {EdgeType} type
 * @property {number} weight
 */

/**
 * @typedef {object} Runtime
 * @property {string | null} lastConsolidation   - ISO timestamp or null.
 * @property {boolean} pendingPersonaRebuild
 * @property {object[]} traces                    - Ring buffer, cap TRACE_BUFFER_CAP.
 */

/**
 * @typedef {object} TierCaches
 * @property {Object<string, string[]>} exact
 * @property {Object<string, string[]>} fuzzy
 */

/**
 * @typedef {object} State
 * @property {Object<string, Entry>} entries
 * @property {string[]} workingBuffer
 * @property {{ edges: Edge[] }} graph
 * @property {TierCaches} tierCaches
 * @property {Runtime} runtime
 */

/** Union of all valid edge types (produced + reserved). Spec §4. */
export const ALL_EDGE_TYPES = Object.freeze([
    ...EDGE_TYPES.PRODUCED,
    ...EDGE_TYPES.RESERVED,
]);

/** Return true iff `s` is a valid scope. */
export function isScope(s) {
    return typeof s === 'string' && SCOPES.includes(s);
}

/** Return true iff `m` is a valid maturity tier. */
export function isMaturity(m) {
    return typeof m === 'string' && MATURITY_TIERS.includes(m);
}

/** Return true iff `t` is a valid edge type (produced or reserved). */
export function isEdgeType(t) {
    return typeof t === 'string' && ALL_EDGE_TYPES.includes(t);
}

/**
 * Build a fresh, empty State. Every field is initialized to its zero
 * value per spec §3.2. No persistence side effects.
 *
 * @returns {State}
 */
export function createEmptyState() {
    return {
        entries: {},
        workingBuffer: [],
        graph: { edges: [] },
        tierCaches: { exact: {}, fuzzy: {} },
        runtime: {
            lastConsolidation: null,
            pendingPersonaRebuild: false,
            traces: [],
        },
    };
}
```

**Step 2:** Write the test (`tests/unit/core/schema.test.js`):

```javascript
import {
    ALL_EDGE_TYPES,
    isScope,
    isMaturity,
    isEdgeType,
    createEmptyState,
} from '../../../src/core/schema.js';

describe('schema', () => {
    test('ALL_EDGE_TYPES includes produced and reserved', () => {
        expect(ALL_EDGE_TYPES).toEqual([
            'mentions', 'supports', 'same_topic', 'temporal_next', 'contradicts',
        ]);
    });

    test('isScope narrows valid scopes only', () => {
        expect(isScope('working')).toBe(true);
        expect(isScope('episodic')).toBe(true);
        expect(isScope('persona')).toBe(true);
        expect(isScope('graph')).toBe(false);
        expect(isScope('')).toBe(false);
        expect(isScope(undefined)).toBe(false);
    });

    test('isMaturity narrows valid tiers only', () => {
        expect(isMaturity('draft')).toBe(true);
        expect(isMaturity('core')).toBe(true);
        expect(isMaturity('graduated')).toBe(false);
    });

    test('isEdgeType accepts produced + reserved', () => {
        expect(isEdgeType('mentions')).toBe(true);
        expect(isEdgeType('contradicts')).toBe(true);
        expect(isEdgeType('unrelated')).toBe(false);
    });

    test('createEmptyState returns a fresh zero-valued State', () => {
        const s = createEmptyState();
        expect(s.entries).toEqual({});
        expect(s.workingBuffer).toEqual([]);
        expect(s.graph).toEqual({ edges: [] });
        expect(s.tierCaches).toEqual({ exact: {}, fuzzy: {} });
        expect(s.runtime.lastConsolidation).toBe(null);
        expect(s.runtime.pendingPersonaRebuild).toBe(false);
        expect(s.runtime.traces).toEqual([]);
    });

    test('createEmptyState returns a fresh object each call (no shared refs)', () => {
        const a = createEmptyState();
        const b = createEmptyState();
        a.entries.foo = /** @type {any} */ ({});
        a.workingBuffer.push('x');
        a.graph.edges.push(/** @type {any} */ ({}));
        expect(b.entries).toEqual({});
        expect(b.workingBuffer).toEqual([]);
        expect(b.graph.edges).toEqual([]);
    });
});
```

**Step 3:** Run `npm run test tests/unit/core/schema.test.js`. Expected: 6 tests PASS.

**Step 4:** Run `npm run lint && npm run typecheck`. Expected: both exit 0.

**Step 5:** Commit.

```bash
git add src/core/schema.js tests/unit/core/schema.test.js
git commit -m "feat(core): add schema typedefs, enum guards, empty-state factory"
```

---

## Task 2: Entry factory and validator

**Objective:** Land `src/memory/entry.js`—`createEntry(fields)` produces a spec-§3.1-compliant Entry with defaulted lifecycle + provenance. `isValidEntry(x)` is a total boolean validator used by later phases (consolidation write-path, Tier 2 BM25 index, trace replay).

**Files:**
- Create: `src/memory/entry.js`
- Create: `tests/unit/memory/entry.test.js`

**Step 1: Write the failing test first** (`tests/unit/memory/entry.test.js`):

```javascript
import { createEntry, isValidEntry, generateEntryId } from '../../../src/memory/entry.js';

describe('entry', () => {
    describe('generateEntryId', () => {
        test('prefixes episodic entries with ep_', () => {
            const id = generateEntryId('episodic', new Date('2026-04-20T14:12:33Z'));
            expect(id.startsWith('ep_2026-04-20T14:12:33')).toBe(true);
        });

        test('prefixes working with wk_ and persona with ps_', () => {
            const now = new Date('2026-04-20T14:12:33Z');
            expect(generateEntryId('working', now).startsWith('wk_')).toBe(true);
            expect(generateEntryId('persona', now).startsWith('ps_')).toBe(true);
        });

        test('appends a short random suffix to disambiguate same-second IDs', () => {
            const now = new Date('2026-04-20T14:12:33Z');
            const a = generateEntryId('episodic', now);
            const b = generateEntryId('episodic', now);
            expect(a).not.toBe(b);
            // suffix is last 3 chars after final underscore
            expect(a.split('_').pop()).toHaveLength(3);
        });
    });

    describe('createEntry', () => {
        const baseFields = {
            scope: 'episodic',
            content: 'Alice grew up in Marseille and moved to Paris at 18.',
            subject: 'alice',
            tags: ['location', 'hometown'],
            provenance: { sourceMessages: [42, 43], extractor: 'test@v1' },
        };

        test('returns a valid entry with defaulted lifecycle', () => {
            const e = createEntry({ ...baseFields });
            expect(e.id).toMatch(/^ep_/);
            expect(e.scope).toBe('episodic');
            expect(e.content).toBe(baseFields.content);
            expect(e.subject).toBe('alice');
            expect(e.tags).toEqual(['location', 'hometown']);
            expect(e.relations).toEqual([]);
            expect(e.lifecycle.importance).toBe(50);
            expect(e.lifecycle.maturity).toBe('draft');
            expect(e.lifecycle.accessCount).toBe(0);
            expect(e.lifecycle.updateCount).toBe(0);
            expect(e.lifecycle.createdAt).toBe(e.lifecycle.updatedAt);
            expect(new Date(e.lifecycle.createdAt).toString()).not.toBe('Invalid Date');
        });

        test('passes custom relations through', () => {
            const e = createEntry({
                ...baseFields,
                relations: [{ type: 'mentions', target: 'ep_abc' }],
            });
            expect(e.relations).toEqual([{ type: 'mentions', target: 'ep_abc' }]);
        });

        test('allows null subject', () => {
            const e = createEntry({ ...baseFields, subject: null });
            expect(e.subject).toBe(null);
            expect(isValidEntry(e)).toBe(true);
        });

        test('uses injected clock if provided (for deterministic tests)', () => {
            const fixed = new Date('2026-04-20T14:12:33Z');
            const e = createEntry({ ...baseFields, now: fixed });
            expect(e.lifecycle.createdAt).toBe('2026-04-20T14:12:33.000Z');
        });

        test('rejects invalid scope', () => {
            expect(() => createEntry({ ...baseFields, scope: 'graph' }))
                .toThrow(/scope/);
        });

        test('rejects empty content', () => {
            expect(() => createEntry({ ...baseFields, content: '' }))
                .toThrow(/content/);
        });

        test('rejects missing provenance', () => {
            const { provenance: _p, ...rest } = baseFields;
            expect(() => createEntry(/** @type {any} */ (rest)))
                .toThrow(/provenance/);
        });
    });

    describe('isValidEntry', () => {
        const good = () => createEntry({
            scope: 'working',
            content: 'hi',
            subject: null,
            tags: [],
            provenance: { sourceMessages: [1], extractor: 'test' },
        });

        test('accepts a freshly built entry', () => {
            expect(isValidEntry(good())).toBe(true);
        });

        test('rejects non-objects', () => {
            expect(isValidEntry(null)).toBe(false);
            expect(isValidEntry(undefined)).toBe(false);
            expect(isValidEntry('x')).toBe(false);
            expect(isValidEntry(42)).toBe(false);
            expect(isValidEntry([])).toBe(false);
        });

        test('rejects entries missing required fields', () => {
            const e = good();
            for (const key of ['id', 'scope', 'content', 'tags', 'relations', 'lifecycle', 'provenance']) {
                const copy = { ...e };
                delete copy[key];
                expect(isValidEntry(copy)).toBe(false);
            }
        });

        test('rejects entries with malformed lifecycle', () => {
            const e = good();
            expect(isValidEntry({ ...e, lifecycle: { ...e.lifecycle, importance: -1 } })).toBe(false);
            expect(isValidEntry({ ...e, lifecycle: { ...e.lifecycle, importance: 101 } })).toBe(false);
            expect(isValidEntry({ ...e, lifecycle: { ...e.lifecycle, maturity: 'legendary' } })).toBe(false);
            expect(isValidEntry({ ...e, lifecycle: { ...e.lifecycle, accessCount: -1 } })).toBe(false);
        });

        test('rejects entries with malformed relations', () => {
            const e = good();
            expect(isValidEntry({ ...e, relations: [{ type: 'bogus', target: 'x' }] })).toBe(false);
            expect(isValidEntry({ ...e, relations: [{ type: 'mentions' }] })).toBe(false);
        });
    });
});
```

**Step 2:** Run `npm run test tests/unit/memory/entry.test.js`. Expected: FAIL (module not found).

**Step 3:** Write `src/memory/entry.js`:

```javascript
/**
 * Entry factory and validator. The one place entries are constructed;
 * consolidation calls `createEntry` and nothing else builds entries ad-hoc.
 *
 * @module memory/entry
 * @see docs/specs/2026-04-20-starmem-v2-design.md §3.1
 */

import { SCOPES, MATURITY_TIERS } from '../core/constants.js';
import { isScope, isMaturity, isEdgeType } from '../core/schema.js';

/** Scope → id prefix. */
const SCOPE_PREFIX = Object.freeze({
    working: 'wk',
    episodic: 'ep',
    persona: 'ps',
});

/**
 * Generate a random 3-char lowercase-hex suffix. Not cryptographic—
 * just enough to disambiguate same-second IDs within a single chat.
 */
function randomSuffix() {
    return Math.floor(Math.random() * 0x1000).toString(16).padStart(3, '0');
}

/**
 * Generate an entry id of the form `<prefix>_<iso>_<suffix>`, e.g.
 * `ep_2026-04-20T14:12:33_a3f`. ISO timestamp is trimmed to second precision.
 *
 * @param {import('../core/schema.js').Scope} scope
 * @param {Date} [now]
 * @returns {string}
 */
export function generateEntryId(scope, now = new Date()) {
    if (!isScope(scope)) {
        throw new Error(`generateEntryId: invalid scope ${String(scope)}`);
    }
    const iso = now.toISOString().replace(/\.\d+Z$/, '');  // strip milliseconds + Z
    return `${SCOPE_PREFIX[scope]}_${iso}_${randomSuffix()}`;
}

/**
 * Build a fresh entry from caller-supplied fields. Defaults lifecycle to
 * spec §7 baseline (importance=50, maturity='draft', counts=0).
 *
 * @param {object} fields
 * @param {import('../core/schema.js').Scope} fields.scope
 * @param {string} fields.content
 * @param {string | null} fields.subject
 * @param {string[]} fields.tags
 * @param {import('../core/schema.js').Relation[]} [fields.relations]
 * @param {import('../core/schema.js').Provenance} fields.provenance
 * @param {Date} [fields.now] - Inject a clock for deterministic tests.
 * @returns {import('../core/schema.js').Entry}
 */
export function createEntry(fields) {
    if (!fields || typeof fields !== 'object') {
        throw new Error('createEntry: fields object required');
    }
    const { scope, content, subject, tags, relations = [], provenance, now } = fields;
    if (!isScope(scope)) {
        throw new Error(`createEntry: invalid scope ${String(scope)}`);
    }
    if (typeof content !== 'string' || content.length === 0) {
        throw new Error('createEntry: content must be a non-empty string');
    }
    if (subject !== null && typeof subject !== 'string') {
        throw new Error('createEntry: subject must be string or null');
    }
    if (!Array.isArray(tags)) {
        throw new Error('createEntry: tags must be an array');
    }
    if (!Array.isArray(relations)) {
        throw new Error('createEntry: relations must be an array');
    }
    if (!provenance || typeof provenance !== 'object'
        || !Array.isArray(provenance.sourceMessages)
        || typeof provenance.extractor !== 'string') {
        throw new Error('createEntry: provenance must be { sourceMessages: number[], extractor: string }');
    }

    const when = now ?? new Date();
    const iso = when.toISOString();

    return {
        id: generateEntryId(scope, when),
        scope,
        content,
        subject,
        tags: [...tags],
        relations: relations.map(r => ({ type: r.type, target: r.target })),
        lifecycle: {
            importance: 50,
            maturity: 'draft',
            createdAt: iso,
            updatedAt: iso,
            accessCount: 0,
            updateCount: 0,
        },
        provenance: {
            sourceMessages: [...provenance.sourceMessages],
            extractor: provenance.extractor,
        },
    };
}

/**
 * Total validator. Returns true iff `x` has the full shape required by
 * spec §3.1. Used by persist/load to reject malformed state and by later
 * phases to guard index builds.
 *
 * @param {unknown} x
 * @returns {boolean}
 */
export function isValidEntry(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const e = /** @type {Record<string, unknown>} */ (x);

    if (typeof e.id !== 'string' || e.id.length === 0) return false;
    if (!isScope(e.scope)) return false;
    if (typeof e.content !== 'string' || e.content.length === 0) return false;
    if (e.subject !== null && typeof e.subject !== 'string') return false;
    if (!Array.isArray(e.tags) || !e.tags.every(t => typeof t === 'string')) return false;

    if (!Array.isArray(e.relations)) return false;
    for (const r of e.relations) {
        if (!r || typeof r !== 'object') return false;
        const rel = /** @type {Record<string, unknown>} */ (r);
        if (!isEdgeType(rel.type)) return false;
        if (typeof rel.target !== 'string' || rel.target.length === 0) return false;
    }

    const l = /** @type {Record<string, unknown>} */ (e.lifecycle);
    if (!l || typeof l !== 'object') return false;
    if (typeof l.importance !== 'number' || l.importance < 0 || l.importance > 100) return false;
    if (!isMaturity(l.maturity)) return false;
    if (typeof l.createdAt !== 'string' || typeof l.updatedAt !== 'string') return false;
    if (typeof l.accessCount !== 'number' || l.accessCount < 0) return false;
    if (typeof l.updateCount !== 'number' || l.updateCount < 0) return false;

    const p = /** @type {Record<string, unknown>} */ (e.provenance);
    if (!p || typeof p !== 'object') return false;
    if (!Array.isArray(p.sourceMessages) || !p.sourceMessages.every(n => typeof n === 'number')) return false;
    if (typeof p.extractor !== 'string') return false;

    // Silence unused-import warnings for constants pulled in for type docs only.
    void SCOPES; void MATURITY_TIERS;
    return true;
}
```

**Step 4:** Run `npm run test tests/unit/memory/entry.test.js`. Expected: all tests PASS.

**Step 5:** Run `npm run lint && npm run typecheck`. Expected: both exit 0. If typecheck objects to `void SCOPES; void MATURITY_TIERS;`, delete those lines and the imports—they exist only if lint flags unused bindings. The imports are decorative; remove if the linter is happy without them.

**Step 6:** Commit.

```bash
git add src/memory/entry.js tests/unit/memory/entry.test.js
git commit -m "feat(memory): add entry factory and total validator per spec §3.1"
```

---

## Task 3: Per-chat async write lock

**Objective:** Land `src/core/lock.js`—`withWriteLock(chatId, fn)`. Promise-chain based: each `withWriteLock` call appends to a per-chat chain and resolves with `fn`'s return value. Guarantees serialized execution per `chatId`; independent chatIds proceed in parallel. This is the enforcement point for spec §2 principle 2 ("many readers, single mutator").

**Files:**
- Create: `src/core/lock.js`
- Create: `tests/unit/core/lock.test.js`

**Step 1:** Write the failing test (`tests/unit/core/lock.test.js`):

```javascript
import { withWriteLock, _resetLocksForTests } from '../../../src/core/lock.js';

describe('withWriteLock', () => {
    beforeEach(() => { _resetLocksForTests(); });

    test('runs fn and returns its result', async () => {
        const result = await withWriteLock('chat-a', async () => 42);
        expect(result).toBe(42);
    });

    test('serializes concurrent calls for the same chatId', async () => {
        const trace = [];
        const task = (label, ms) => withWriteLock('chat-a', async () => {
            trace.push(`start:${label}`);
            await new Promise(r => setTimeout(r, ms));
            trace.push(`end:${label}`);
            return label;
        });
        const results = await Promise.all([task('A', 30), task('B', 10), task('C', 5)]);
        // The second task does not start until the first ends, etc.
        expect(trace).toEqual([
            'start:A', 'end:A',
            'start:B', 'end:B',
            'start:C', 'end:C',
        ]);
        expect(results).toEqual(['A', 'B', 'C']);
    });

    test('runs independent chatIds in parallel', async () => {
        const trace = [];
        const task = (chat, label, ms) => withWriteLock(chat, async () => {
            trace.push(`start:${label}`);
            await new Promise(r => setTimeout(r, ms));
            trace.push(`end:${label}`);
        });
        await Promise.all([task('chat-a', 'A', 30), task('chat-b', 'B', 5)]);
        // B finishes before A (different chats, no contention)
        const aEnd = trace.indexOf('end:A');
        const bEnd = trace.indexOf('end:B');
        expect(bEnd).toBeLessThan(aEnd);
    });

    test('releases the lock on fn throw; subsequent calls still run', async () => {
        await expect(
            withWriteLock('chat-a', async () => { throw new Error('boom'); })
        ).rejects.toThrow('boom');
        const v = await withWriteLock('chat-a', async () => 'ok');
        expect(v).toBe('ok');
    });

    test('rejects non-function fn', async () => {
        await expect(withWriteLock('chat-a', /** @type {any} */ (null)))
            .rejects.toThrow(/function/);
    });
});
```

**Step 2:** Run it. Expected: FAIL (module not found).

**Step 3:** Write `src/core/lock.js`:

```javascript
/**
 * Per-chat async write lock. Spec §2 principle 2 says "one path per
 * responsibility…many readers, single mutator." This module is that
 * single mutator's gatekeeper: every long-term mutation must flow
 * through `withWriteLock`.
 *
 * Implementation: a `Map<chatId, Promise<void>>` of tail promises.
 * Each call appends an awaiter to the chain and returns the caller's
 * eventual result. Errors in one call do not poison the chain.
 *
 * @module core/lock
 */

/** @type {Map<string, Promise<void>>} */
const tails = new Map();

/**
 * Run `fn` in mutual exclusion with any other `withWriteLock` call for
 * the same `chatId`. Independent chatIds run in parallel.
 *
 * @template T
 * @param {string} chatId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withWriteLock(chatId, fn) {
    if (typeof fn !== 'function') {
        return Promise.reject(new Error('withWriteLock: fn must be a function'));
    }
    if (typeof chatId !== 'string' || chatId.length === 0) {
        return Promise.reject(new Error('withWriteLock: chatId must be a non-empty string'));
    }

    const prev = tails.get(chatId) ?? Promise.resolve();
    // The next tail waits for prev to settle, then runs fn. We swallow prev's
    // rejection for chain-continuity but let fn's result propagate to the caller.
    const run = prev.catch(() => {}).then(() => fn());
    // The tail only tracks completion (not value) so its type matches Map signature.
    const tail = run.then(() => {}, () => {});
    tails.set(chatId, tail);
    // Clean up the Map once this tail settles, but only if it's still the latest.
    tail.finally(() => {
        if (tails.get(chatId) === tail) {
            tails.delete(chatId);
        }
    });
    return run;
}

/**
 * Clear all in-flight lock state. Test-only escape hatch. Never call
 * this from production code; any pending `withWriteLock` callers will
 * still execute, but their serialization guarantee is voided.
 */
export function _resetLocksForTests() {
    tails.clear();
}
```

**Step 4:** Run `npm run test tests/unit/core/lock.test.js`. Expected: all tests PASS.

**Step 5:** Run `npm run lint && npm run typecheck`. Expected: both exit 0.

**Step 6:** Commit.

```bash
git add src/core/lock.js tests/unit/core/lock.test.js
git commit -m "feat(core): add per-chat async write lock (spec §2 principle 2)"
```

---

## Task 4: State I/O with injectable backend

**Objective:** Land `src/core/state.js`—`loadState(chatId)` and `persistState(chatId, state)` plus a `setBackend(backend)` escape hatch. The default backend reads `globalThis.chat_metadata['STARmem']` and calls `globalThis.saveMetadataDebounced()`. Tests inject an in-memory Map-backed mock.

**Files:**
- Create: `src/core/state.js`
- Create: `tests/unit/core/state.test.js`

**Step 1:** Write the failing test (`tests/unit/core/state.test.js`):

```javascript
import { createEmptyState } from '../../../src/core/schema.js';
import {
    loadState,
    persistState,
    setBackend,
    _resetBackendForTests,
} from '../../../src/core/state.js';

/** In-memory backend for deterministic tests. */
function makeMemoryBackend() {
    const store = new Map();
    return {
        store,
        read: (key) => store.has(key) ? structuredClone(store.get(key)) : undefined,
        write: (key, value) => { store.set(key, structuredClone(value)); },
    };
}

describe('state I/O', () => {
    afterEach(() => { _resetBackendForTests(); });

    test('loadState returns an empty State when nothing is stored', async () => {
        setBackend(makeMemoryBackend());
        const s = await loadState('chat-a');
        expect(s).toEqual(createEmptyState());
    });

    test('persist then load round-trips structurally', async () => {
        setBackend(makeMemoryBackend());
        const original = createEmptyState();
        original.workingBuffer.push('wk_abc');
        original.runtime.lastConsolidation = '2026-04-20T14:12:33Z';
        await persistState('chat-a', original);
        const loaded = await loadState('chat-a');
        expect(loaded).toEqual(original);
        // Returned object is independent of the stored one (deep clone).
        loaded.workingBuffer.push('wk_xyz');
        const reloaded = await loadState('chat-a');
        expect(reloaded.workingBuffer).toEqual(['wk_abc']);
    });

    test('persistState rejects non-object state', async () => {
        setBackend(makeMemoryBackend());
        await expect(persistState('chat-a', /** @type {any} */ (null)))
            .rejects.toThrow(/state/);
    });

    test('loadState recovers an empty State when stored value is malformed', async () => {
        const backend = makeMemoryBackend();
        setBackend(backend);
        backend.store.set('chat-a', 42);  // corrupted
        const s = await loadState('chat-a');
        expect(s).toEqual(createEmptyState());
    });

    test('different chatIds do not collide', async () => {
        setBackend(makeMemoryBackend());
        const sa = createEmptyState(); sa.workingBuffer.push('a');
        const sb = createEmptyState(); sb.workingBuffer.push('b');
        await persistState('chat-a', sa);
        await persistState('chat-b', sb);
        expect((await loadState('chat-a')).workingBuffer).toEqual(['a']);
        expect((await loadState('chat-b')).workingBuffer).toEqual(['b']);
    });
});
```

**Step 2:** Run it. Expected: FAIL (module not found).

**Step 3:** Write `src/core/state.js`:

```javascript
/**
 * State I/O. Bridges STARmem's in-memory State tree to SillyTavern's
 * chatMetadata['STARmem'] slot. The backend is injectable so unit tests
 * substitute an in-memory Map for ST globals.
 *
 * Spec §3 says the entire STARmem tree lives at chatMetadata['STARmem'].
 * ChatId is the lock key (see core/lock.js) and a log discriminator, not
 * a storage key—ST swaps the active chatMetadata when the user switches
 * chats, so our default backend reads whatever is current.
 *
 * @module core/state
 * @see docs/specs/2026-04-20-starmem-v2-design.md §3
 */

import { createEmptyState } from './schema.js';

const METADATA_KEY = 'STARmem';

/**
 * @typedef {object} Backend
 * @property {(chatId: string) => unknown} read   - Returns raw stored value or undefined.
 * @property {(chatId: string, value: unknown) => void} write
 */

/** @returns {Backend} */
function makeDefaultBackend() {
    return {
        read: (_chatId) => {
            const meta = /** @type {Record<string, unknown> | undefined} */ (
                /** @type {any} */ (globalThis).chat_metadata
            );
            return meta?.[METADATA_KEY];
        },
        write: (_chatId, value) => {
            const g = /** @type {any} */ (globalThis);
            g.chat_metadata = g.chat_metadata ?? {};
            g.chat_metadata[METADATA_KEY] = value;
            if (typeof g.saveMetadataDebounced === 'function') {
                g.saveMetadataDebounced();
            }
        },
    };
}

/** @type {Backend} */
let backend = makeDefaultBackend();

/**
 * Replace the storage backend. Callers are the SillyTavern integration
 * layer (Phase 8) on startup, and unit tests.
 *
 * @param {Backend} b
 */
export function setBackend(b) {
    if (!b || typeof b.read !== 'function' || typeof b.write !== 'function') {
        throw new Error('setBackend: backend must expose read() and write()');
    }
    backend = b;
}

/** Test-only: restore the default backend. */
export function _resetBackendForTests() {
    backend = makeDefaultBackend();
}

/**
 * Shape-check for State. Loose—rejects primitives and arrays, accepts
 * any object with the five top-level keys. Deep validation happens at
 * use-sites (isValidEntry when indexing, etc.).
 *
 * @param {unknown} x
 * @returns {boolean}
 */
function looksLikeState(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const s = /** @type {Record<string, unknown>} */ (x);
    return (
        typeof s.entries === 'object' && s.entries !== null && !Array.isArray(s.entries)
        && Array.isArray(s.workingBuffer)
        && typeof s.graph === 'object' && s.graph !== null
        && typeof s.tierCaches === 'object' && s.tierCaches !== null
        && typeof s.runtime === 'object' && s.runtime !== null
    );
}

/**
 * Load STARmem state for a chat. Returns a fresh empty State if nothing
 * is stored or the stored value is malformed. Always returns a deep-
 * cloned object independent of the backend's storage.
 *
 * @param {string} chatId
 * @returns {Promise<import('./schema.js').State>}
 */
export async function loadState(chatId) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('loadState: chatId must be a non-empty string');
    }
    const raw = backend.read(chatId);
    if (!looksLikeState(raw)) {
        return createEmptyState();
    }
    return /** @type {import('./schema.js').State} */ (structuredClone(raw));
}

/**
 * Persist STARmem state for a chat. Caller is responsible for holding
 * the write lock (see core/lock.js); this function does not acquire it.
 *
 * @param {string} chatId
 * @param {import('./schema.js').State} state
 * @returns {Promise<void>}
 */
export async function persistState(chatId, state) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('persistState: chatId must be a non-empty string');
    }
    if (!looksLikeState(state)) {
        throw new Error('persistState: state does not match expected shape');
    }
    backend.write(chatId, structuredClone(state));
}
```

**Step 4:** Run `npm run test tests/unit/core/state.test.js`. Expected: all tests PASS.

**Step 5:** Run `npm run lint && npm run typecheck`. Expected: both exit 0.

**Step 6:** Commit.

```bash
git add src/core/state.js tests/unit/core/state.test.js
git commit -m "feat(core): add state I/O with injectable chatMetadata backend"
```

---

## Task 5: Integration test — lock + state round-trip

**Objective:** Prove the three primitives compose correctly: two concurrent `withWriteLock` callers both mutate state, and the second only starts after the first's persist has landed.

**Files:**
- Create: `tests/integration/storage-roundtrip.test.js`

**Step 1:** Write the test:

```javascript
import { withWriteLock, _resetLocksForTests } from '../../src/core/lock.js';
import { loadState, persistState, setBackend, _resetBackendForTests } from '../../src/core/state.js';
import { createEntry } from '../../src/memory/entry.js';

function makeMemoryBackend() {
    const store = new Map();
    return {
        store,
        read: (key) => store.has(key) ? structuredClone(store.get(key)) : undefined,
        write: (key, value) => { store.set(key, structuredClone(value)); },
    };
}

describe('storage round-trip (integration)', () => {
    beforeEach(() => {
        _resetLocksForTests();
        setBackend(makeMemoryBackend());
    });
    afterEach(() => { _resetBackendForTests(); });

    test('two concurrent lock-wrapped mutations both land in order', async () => {
        const addEntry = (chatId, scope, content) => withWriteLock(chatId, async () => {
            const s = await loadState(chatId);
            const e = createEntry({
                scope, content, subject: null, tags: [],
                provenance: { sourceMessages: [], extractor: 'test' },
            });
            s.entries[e.id] = e;
            s.workingBuffer.push(e.id);
            await persistState(chatId, s);
            return e.id;
        });

        const [idA, idB] = await Promise.all([
            addEntry('chat-a', 'working', 'first'),
            addEntry('chat-a', 'working', 'second'),
        ]);

        const finalState = await loadState('chat-a');
        expect(Object.keys(finalState.entries).sort()).toEqual([idA, idB].sort());
        expect(finalState.workingBuffer).toEqual([idA, idB]);
    });

    test('lock-free interleaving would corrupt state (control demonstration)', async () => {
        // Without the lock, both callers read the same empty state and one
        // write clobbers the other. This test proves the hazard the lock exists
        // to prevent—without actually using the lock.
        const addUnlocked = async (chatId, content) => {
            const s = await loadState(chatId);
            await new Promise(r => setTimeout(r, 10));  // widen the race window
            const e = createEntry({
                scope: 'working', content, subject: null, tags: [],
                provenance: { sourceMessages: [], extractor: 'test' },
            });
            s.entries[e.id] = e;
            s.workingBuffer.push(e.id);
            await persistState(chatId, s);
            return e.id;
        };

        await Promise.all([
            addUnlocked('chat-a', 'first'),
            addUnlocked('chat-a', 'second'),
        ]);

        const finalState = await loadState('chat-a');
        // Exactly one write survives; the other is lost.
        expect(Object.keys(finalState.entries)).toHaveLength(1);
        expect(finalState.workingBuffer).toHaveLength(1);
    });
});
```

**Step 2:** Run `npm run test tests/integration/storage-roundtrip.test.js`. Expected: 2 tests PASS.

**Step 3:** Run the full suite: `npm run test`. Expected: all Phase 0 + Phase 1 tests PASS (13 prior + ~20 new = ~33 tests).

**Step 4:** Run `npm run lint && npm run typecheck`. Expected: both exit 0.

**Step 5:** Commit.

```bash
git add tests/integration/storage-roundtrip.test.js
git commit -m "test(storage): integration round-trip proving lock composes with state I/O"
```

---

## Task 6: Phase 1 retro

**Objective:** Append a retro section to `docs/plans/ROADMAP.md`—what shipped, surprises, notes for Phase 2. Required by roadmap §4 "Documentation discipline."

**Files:**
- Modify: `docs/plans/ROADMAP.md`

**Step 1:** Append a section at the end of `ROADMAP.md`:

```markdown
## Phase 1—YYYY-MM-DD

**What shipped:** `src/core/schema.js` (typedefs + enum guards + `createEmptyState`), `src/memory/entry.js` (`createEntry` + `generateEntryId` + `isValidEntry`), `src/core/lock.js` (per-chat async mutex), `src/core/state.js` (injectable backend, loose state shape check, deep-clone round-trip), integration round-trip test proving the three primitives compose. N commits, M tests passing total.

**Surprises:**

- [Fill in as discovered during implementation.]

**Notes for Phase 2 (Lifecycle):**

- Lifecycle math lives in `src/lifecycle/*.js`—pure functions, no state mutation. Import types from `core/schema.js`.
- The hysteresis test is the important one: oscillate importance 60→70→60 and verify maturity stays `validated`.
- Golden-value tests are the easiest way to pin formulas; the roadmap lists the expected value `importance=50 → 7 accesses → 71`.
```

**Step 2:** Replace `YYYY-MM-DD` with today's date and `N`/`M` with actual counts.

**Step 3:** Run `git diff docs/plans/ROADMAP.md` to verify only an append.

**Step 4:** Commit.

```bash
git add docs/plans/ROADMAP.md
git commit -m "docs(plans): Phase 1 retro"
```

---

## Phase-boundary checklist

Before declaring Phase 1 done (roadmap §4 "Spec compliance checklist"):

- [ ] Every exported function introduced this phase is referenced in the roadmap's "Inter-phase contract" block for Phase 1.
- [ ] No function added touches the retrieval path (spec §2 principle 1).
- [ ] `withWriteLock` is the only write-side primitive; consolidate uses it, direct callers do not skip it. (This is enforced by review, not code, until Phase 6's lint/test rule lands.)
- [ ] No embeddings, no migration code, no setup wizard, no health checks (spec §11).
- [ ] `npm run test`, `npm run lint`, `npm run typecheck` all exit 0.
- [ ] Git history is linear, one commit per task, conventional commit messages.

---

## What this phase deliberately does NOT do

- **No retrieval.** Tier 0/1/2 caches are shaped in State but never read or written. That's Phase 4.
- **No edges built from entries.** `relations` is stored as-is; edge-builder logic is Phase 5.
- **No consolidation.** `workingBuffer` is a bare string array; nothing drains it. That's Phase 6.
- **No lifecycle math.** Entries are created with defaults and never updated. That's Phase 2.
- **No trace logger.** The `runtime.traces` field exists but is empty. That's Phase 4.
- **No ST integration.** `setBackend` is the hook; the actual interceptor + settings UI is Phase 8.

If any of these creep in during implementation, stop and review—scope drift at this boundary is the most common way phased builds turn into monolithic ones.
