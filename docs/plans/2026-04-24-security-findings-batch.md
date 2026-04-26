# Security Findings Batch — 2026-04-24

> **For Hermes:** Use `subagent-driven-development` skill to execute this plan task-by-task. Each task ends with `git commit` — do not batch commits.

**Goal:** Resolve 16 code-review findings from Codex security scan (`/tmp/codex-security-findings-2026-04-24T16-16-31.096Z.csv`) in 7 themed commits on branch `fix/security-findings-batch-2026-04-24`.

**Architecture:** Worktree at `../STARmem-security/`; branches off `main@0dbe569`. No behaviour changes to the hot retrieval path except the Tier 0/1 cache (which gets bounded LRU, parametrized via `RETRIEVAL.TIER_CACHE_MAX_ENTRIES` so Phase 9.x can sweep it). `node:crypto` import replaced with vendored pure-JS SHA-256 to unblock browser loading. Prototype-key pollution hardened across five surfaces. Interceptor race fixed by moving `loadState` inside the write lock. Bench CLIs get `path.basename`-style sanitization.

**Tech Stack:** Vanilla ES2022 JS (no build step — per `AGENTS.md`, runtime code loads directly in the browser). `node:test` (built-in Node test runner via `npm test`). Python 3 for bench HTML renderer (Task 7c only).

---

**Decisions locked before writing this plan (see conversation 2026-04-24):**

1. **SHA-256 replacement strategy (Task 1).** Vendor a pure-JS SHA-256 into `src/vendor/sha256.js`, use it in `src/memory/entry.js`. Spec-faithful — preserves the "12 hex chars of sha256" invariant documented in that file's comments. Unit test includes known SHA-256 vectors ("" → e3b0c442…, "abc" → ba7816bf…) so it cannot silently drift.
2. **Default-backend policy (Task 3e).** Hard-fail when `loadState`/`persistState` are called before `setBackend()`. The default backend's `read` and `write` both throw a clear error pointing to `bootstrap()`. Bootstrap-must-run becomes an enforced invariant; tests that need a backend substitute one via `setBackend(...)` (the existing `_resetBackendForTests` stays for restoration).
3. **Tier-cache cap parametrization (Task 4).** New `RETRIEVAL.TIER_CACHE_MAX_ENTRIES = 200` (integer), added to `_SWEPT_RETRIEVAL_KEYS` so `setConstantOverrides({TIER_CACHE_MAX_ENTRIES: N})` works for sweeps. Eviction is insertion-order LRU (drop oldest N - cap on each write). 200 is the default, Phase 9.x sweep candidate.
4. **Stuck `consolidating` flag (Task 3d).** Clear on happy-path success AND on the early-return path (when a prior stale flag was seen). No retry logic — just drop it so the next trigger proceeds normally. Document on the log line.
5. **Tier 2 scorer-bypass finding #9.** Not fixed in this batch — 9.4.7 deliberately inlined factor decomposition and a tracking comment already exists. Left in place for Phase 11 revisit.
6. **Task ordering.** 1 → 5 → 6 → 2 → 3 → 4 → 7. Browser-loading P0 first, then the one-line race fix, then the two-line NaN fix, then the sweeping hardening.
7. **Worktree.** `../STARmem-security/` off main@0dbe569. PR against `EvaL3n4/SillyTavern-STARmem` when the branch is green.

**Finding → task mapping (all 16 findings land):**

| Task | Findings | Severity |
|------|----------|----------|
| 1 | #10 | P0 (Codex: informational — but browser-blocking) |
| 2 | #1 #2 #14 | low |
| 3 | #3 #5 #13 #15 #16 | mixed low/info |
| 4 | #4 | low |
| 5 | #12 | informational (real correctness) |
| 6 | #11 | informational (real UI bug) |
| 7 | #6 #7 #8 | informational |

Finding #9 (scorer bypass) is a deliberate deviation — documented in-file, not in this batch.

---

## Task 0: Preflight — verify worktree, branch, and test baseline

**Objective:** Confirm we're on the right branch and the full test suite is green before any edits.

**Files:** none.

**Step 1:** Confirm branch and HEAD.

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/STARmem-security
git branch --show-current
# Expected: fix/security-findings-batch-2026-04-24
git log -1 --oneline
# Expected: 0dbe569 feat(bench): add mobile-friendly HTML output + clean pipe-table markdown default.
```

**Step 2:** Run the full test suite to establish a green baseline.

```bash
npm test 2>&1 | tail -20
```

**Expected:** All tests pass. Note the total count (e.g. "N tests passed"); this is the baseline every later task must meet or exceed.

**Step 3:** Commit the plan itself.

```bash
git add docs/plans/2026-04-24-security-findings-batch.md
git commit -m "docs(plans): security findings batch 2026-04-24"
```

---
## Task 1: Vendor pure-JS SHA-256 and unblock browser loading

**Objective:** Replace `import { createHash } from 'node:crypto'` in `src/memory/entry.js` with a vendored pure-JS SHA-256. Loading STARmem in a browser currently throws because `node:crypto` is Node-only.

**Finding:** #10 — `node:crypto import breaks browser extension loading`.

**Files:**
- Create: `src/vendor/sha256.js` (pure-JS sha256, ~90 LOC, public-domain provenance in header)
- Create: `tests/unit/vendor/sha256.test.js`
- Modify: `src/memory/entry.js` (replace import + call site)

**Step 1 — Write failing test.**

Create `tests/unit/vendor/sha256.test.js`:

```js
/**
 * Verify our vendored SHA-256 matches the reference implementation at
 * Node's node:crypto and against NIST FIPS 180-4 published vectors.
 */
import { describe, test, expect } from '@jest/globals';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../../src/vendor/sha256.js';

describe('sha256Hex', () => {
    test('empty string matches published vector', () => {
        expect(sha256Hex('')).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        );
    });

    test('"abc" matches FIPS 180-4 published vector', () => {
        expect(sha256Hex('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
    });

    test('matches node:crypto on 256 random-ish inputs', () => {
        for (let i = 0; i < 256; i++) {
            const s = `input-${i}-${i * 13}-${String.fromCharCode(i)}`;
            const ours = sha256Hex(s);
            const theirs = createHash('sha256').update(s).digest('hex');
            expect(ours).toBe(theirs);
        }
    });

    test('handles Unicode correctly (UTF-8 encoding)', () => {
        // "🌸" (U+1F338) as UTF-8 bytes → SHA-256
        const emoji = '🌸';
        const ours = sha256Hex(emoji);
        const theirs = createHash('sha256').update(emoji, 'utf8').digest('hex');
        expect(ours).toBe(theirs);
    });

    test('returns 64 lowercase hex chars regardless of input', () => {
        for (const s of ['', 'a', 'hello world', '0', '\n', '\x00\x01\x02']) {
            const result = sha256Hex(s);
            expect(result).toMatch(/^[0-9a-f]{64}$/);
        }
    });
});
```

Run: `npx jest tests/unit/vendor/sha256.test.js 2>&1 | tail -15`
Expected: FAIL — `Cannot find module '.../src/vendor/sha256.js'`.

**Step 2 — Implement `src/vendor/sha256.js`.**

Create the file with this content (pure-JS SHA-256 derived from the public-domain reference; UTF-8-aware):

```js
/**
 * Pure-JS SHA-256 — vendored to avoid node:crypto in browser-loaded code.
 *
 * Provenance: implementation follows FIPS 180-4 §6.2 (SHA-256 algorithm).
 * No external dependencies. Public-domain style — feel free to adapt.
 *
 * Used by src/memory/entry.js::contentSuffix for deterministic entry ids.
 * Verified bit-identical to node:crypto.createHash('sha256') across
 * published test vectors and 256 random-ish inputs (see the test suite).
 *
 * Byte handling: JS strings are UTF-16; we encode to UTF-8 via TextEncoder
 * to match node:crypto's default behaviour.
 *
 * @module vendor/sha256
 */

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ROTR = (x, n) => (x >>> n) | (x << (32 - n));

/**
 * Compute SHA-256 of a string and return a 64-char lowercase hex digest.
 * Identical output to `require('crypto').createHash('sha256').update(s).digest('hex')`.
 *
 * @param {string} input
 * @returns {string} 64-character hex digest
 */
export function sha256Hex(input) {
    if (typeof input !== 'string') {
        throw new TypeError('sha256Hex: input must be a string');
    }
    const bytes = new TextEncoder().encode(input);
    const bitLen = bytes.length * 8;

    // Pad: append 0x80, then zeros, then 64-bit big-endian length
    const padLen = (56 - (bytes.length + 1) % 64 + 64) % 64;
    const padded = new Uint8Array(bytes.length + 1 + padLen + 8);
    padded.set(bytes, 0);
    padded[bytes.length] = 0x80;
    // Length in bits, big-endian, 64-bit. JS bitLen is safe up to 2^53.
    const high = Math.floor(bitLen / 0x100000000);
    const low = bitLen >>> 0;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, high, false);
    dv.setUint32(padded.length - 4, low, false);

    // Initial hash
    const H = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);

    const W = new Uint32Array(64);
    for (let i = 0; i < padded.length; i += 64) {
        for (let t = 0; t < 16; t++) {
            W[t] = dv.getUint32(i + t * 4, false);
        }
        for (let t = 16; t < 64; t++) {
            const s0 = ROTR(W[t - 15], 7) ^ ROTR(W[t - 15], 18) ^ (W[t - 15] >>> 3);
            const s1 = ROTR(W[t - 2], 17) ^ ROTR(W[t - 2], 19) ^ (W[t - 2] >>> 10);
            W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
        }

        let [a, b, c, d, e, f, g, h] = H;
        for (let t = 0; t < 64; t++) {
            const S1 = ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
            const S0 = ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22);
            const mj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + mj) | 0;
            h = g; g = f; f = e;
            e = (d + temp1) | 0;
            d = c; c = b; b = a;
            a = (temp1 + temp2) | 0;
        }
        H[0] = (H[0] + a) | 0;
        H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0;
        H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0;
        H[5] = (H[5] + f) | 0;
        H[6] = (H[6] + g) | 0;
        H[7] = (H[7] + h) | 0;
    }

    let out = '';
    for (let i = 0; i < 8; i++) {
        out += H[i].toString(16).padStart(8, '0');
    }
    return out;
}
```

**Step 3 — Run the test, verify pass.**

Run: `npx jest tests/unit/vendor/sha256.test.js 2>&1 | tail -10`
Expected: PASS — 5 tests.

**Step 4 — Replace the import and call site in `src/memory/entry.js`.**

Patch `src/memory/entry.js`:
- Line 9: `import { createHash } from 'node:crypto';` → `import { sha256Hex } from '../vendor/sha256.js';`
- Line 29: `return createHash('sha256').update(seed).digest('hex').slice(0, 12);` → `return sha256Hex(seed).slice(0, 12);`

**Step 5 — Run the entry.js test suite to confirm determinism is preserved.**

```bash
npx jest tests/unit/memory/entry 2>&1 | tail -10
```

Expected: all tests pass (the entry-id determinism test from 9.4.5 should still pass — identical seed → identical 12-char suffix).

**Step 6 — Check no other file imports `node:crypto`.**

```bash
# Search src/ (not bench/ — bench is Node-only and allowed to use node:crypto)
grep -rn "'node:crypto'\|from 'crypto'" src/
```

Expected: zero matches.

**Step 7 — Full suite.**

```bash
npm test 2>&1 | tail -10
```

Expected: all pass, same count as Task 0 baseline + 5 new sha256 tests.

**Step 8 — Commit.**

```bash
git add src/vendor/sha256.js tests/unit/vendor/sha256.test.js src/memory/entry.js
git commit -m "fix(memory): vendor pure-JS SHA-256, drop node:crypto for browser loading

Finding #10 (Codex 2026-04-24): src/memory/entry.js imported node:crypto
at module top. SillyTavern extensions load directly in the browser with
no build step — this threw during module evaluation and prevented
STARmem from loading at all.

Vendor a public-domain pure-JS SHA-256 in src/vendor/sha256.js. Verified
bit-identical to node:crypto across FIPS 180-4 vectors and 256 random-ish
inputs (tests/unit/vendor/sha256.test.js). Unicode handling goes through
TextEncoder for UTF-8 parity with node:crypto's default.

Entry id determinism preserved — identical (scope, content, subject,
tags, sourceMessages, extractor) seed → identical 12-hex suffix."
```

---

## Task 2: Fix the retrieve→persist race in the interceptor

**Objective:** Move `loadState(chatId)` inside `withWriteLock` in `src/integration/interceptor.js::starmemInterceptor` so load→retrieve→persist is atomic. Prevents the interceptor from overwriting concurrent consolidation or persona-rebuild commits.

**Finding:** #12 — `Race condition in interceptor can overwrite state`.

**Files:**
- Modify: `src/integration/interceptor.js` (restructure the main body)
- Modify: `tests/unit/integration/interceptor.test.js` (add regression test)

**Step 1 — Write failing regression test.**

Open `tests/unit/integration/interceptor.test.js`. Inside the existing `describe('starmemInterceptor')` block, add a new test:

```js
test('acquires write lock BEFORE loading state (no retrieve→persist race)', async () => {
    // Setup: pre-seed state with one episodic entry.
    const chatId = 'race-test';
    const e1 = createEntry({
        scope: 'episodic',
        content: 'Alice lives in Paris.',
        subject: 'alice', tags: ['location'], relations: [],
        provenance: { sourceMessages: [0], extractor: 'test@v1' },
        now: new Date('2026-04-24T12:00:00Z'),
    });
    const initial = { ...createEmptyState(), entries: { [e1.id]: e1 } };
    setBackend({
        read: () => structuredClone(initial),
        write: (_id, v) => { initial.entries = v.entries; initial.workingBuffer = v.workingBuffer; },
    });
    _setContextForTests({ chatId });

    const chat = [
        { name: 'U', is_user: true, is_system: false, send_date: '', mes: 'where does alice live?' },
    ];

    // Instrumentation: track the order in which the lock is taken vs state is read.
    // We hijack loadState by wrapping it — if it's called before the lock is held,
    // this flag stays false. The interceptor MUST call loadState while holding the lock.
    let lockHeldWhenLoaded = false;
    const { _getLockSetForTests } = await import('../../../src/core/lock.js');

    const origLoad = (await import('../../../src/core/state.js')).loadState;
    jest.spyOn(await import('../../../src/core/state.js'), 'loadState')
        .mockImplementation(async (id) => {
            lockHeldWhenLoaded = _getLockSetForTests().has(id);
            return origLoad(id);
        });

    await starmemInterceptor(chat, 4096, () => {}, 'normal');

    expect(lockHeldWhenLoaded).toBe(true);
});
```

If `_getLockSetForTests` doesn't exist yet in `src/core/lock.js`, add this minimal helper at the end of that module:

```js
/** Test-only: expose the in-flight lock set for race-detection tests. */
export function _getLockSetForTests() {
    // `locks` is the module-scoped Map<string, Promise> used by withWriteLock.
    // Returns the set of chatIds currently locked.
    return new Set(locks.keys());
}
```

Then add an import for it alongside the existing state-module imports in the test file.

Run: `npx jest tests/unit/integration/interceptor 2>&1 | tail -15`
Expected: FAIL — `lockHeldWhenLoaded` is `false` because `loadState()` runs before `withWriteLock`.

**Step 2 — Fix `starmemInterceptor`.**

Patch `src/integration/interceptor.js` — replace the body of `starmemInterceptor` between the existing `const query = extractLastUserQuery(chat);` guard and the `chat.splice(...)` call. The new structure: put load+retrieve+persist inside a single `withWriteLock`; return the entries from the lock callback, then splice outside the lock.

Replace lines 150-175 (everything from the "Load state + run ladder." comment through the second `withWriteLock` block) with:

```js
        // Atomically load → retrieve → persist under the write lock so
        // concurrent consolidation/persona-rebuild commits don't get
        // overwritten by our stale snapshot. retrieve() is pure.
        const entries = await withWriteLock(chatId, async () => {
            const state = await loadState(chatId);
            const result = retrieve(state, query, { now: new Date() });
            if (result?.state) {
                await persistState(chatId, result.state);
            }
            return Array.isArray(result?.entries) ? result.entries : [];
        });

        if (entries.length === 0) {
            log.debug('retrieval returned zero entries');
            return;
        }
```

**Step 3 — Rerun the new test, verify pass.**

```bash
npx jest tests/unit/integration/interceptor 2>&1 | tail -10
```

Expected: PASS, including the new race test.

**Step 4 — Full suite to confirm no regression.**

```bash
npm test 2>&1 | tail -10
```

Expected: all pass.

**Step 5 — Commit.**

```bash
git add src/integration/interceptor.js src/core/lock.js tests/unit/integration/interceptor.test.js
git commit -m "fix(integration): interceptor load→retrieve→persist is atomic

Finding #12 (Codex 2026-04-24): starmemInterceptor loaded state outside
the write lock, then persisted inside it. If consolidation or persona
rebuild committed state between load and persist, the interceptor would
overwrite those updates with its stale snapshot.

Move loadState(chatId) inside withWriteLock so the load → retrieve →
persist sequence runs atomically under the single-mutator invariant
(spec §2 principle 2). retrieve() is pure, so correctness is preserved.

Add regression test that instruments loadState to assert the chatId is
in the lock set at call time. _getLockSetForTests() is a new test-only
helper on src/core/lock.js."
```

---

## Task 3: Fix episodic-tab recency NaN

**Objective:** `src/integration/viewer/tabs/episodic.js` passes `lifecycle` (an object) to `recencyAt(now, createdAt)` which expects a Date/ISO string. Every recency score renders NaN and the sort is broken.

**Finding:** #11 — `Episodic tab misuses recencyAt arguments`.

**Files:**
- Modify: `src/integration/viewer/tabs/episodic.js` (two call sites)
- Create: `tests/unit/integration/viewer/episodic-recency.test.js`

**Step 1 — Write failing test.**

Create `tests/unit/integration/viewer/episodic-recency.test.js`:

```js
/**
 * Regression for finding #11: episodic tab passed lifecycle (an object) to
 * recencyAt, producing NaN. After the fix, recency is a finite number in [0, 1].
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { renderTab } from '../../../../src/integration/viewer/tabs/episodic.js';

describe('episodic tab recency rendering', () => {
    let dom;
    beforeEach(() => {
        dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
        globalThis.document = dom.window.document;
        globalThis.HTMLElement = dom.window.HTMLElement;
    });

    test('renders a finite recency score for each episodic entry', async () => {
        const entries = {
            'ep_1': {
                id: 'ep_1', scope: 'episodic', content: 'Alice lives in Paris.',
                subject: 'alice', tags: [], relations: [],
                lifecycle: {
                    importance: 50, maturity: 'draft',
                    createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
                    updatedAt: new Date().toISOString(),
                    accessCount: 0, updateCount: 0,
                },
                provenance: { sourceMessages: [0], extractor: 'test@v1' },
            },
        };
        const parent = dom.window.document.getElementById('root');
        await renderTab(parent, { chatId: 'c1', subjectFilter: '', state: { entries } });
        const scores = parent.querySelector('.starmem-viewer-scores');
        expect(scores).not.toBeNull();
        expect(scores.textContent).not.toMatch(/NaN/);
        // Format: "I=50  R=0.97  draft·0.85" — R value is a finite number.
        expect(scores.textContent).toMatch(/R=\d+\.\d{2}/);
    });
});
```

Run: `npx jest tests/unit/integration/viewer/episodic 2>&1 | tail -10`
Expected: FAIL — `expect(scores.textContent).not.toMatch(/NaN/)` fails because the current code produces `R=NaN`.

**Step 2 — Fix the two call sites in `src/integration/viewer/tabs/episodic.js`.**

- Line 76: `sorted.sort((a, b) => recencyAt(b.lifecycle, now) - recencyAt(a.lifecycle, now));`
  → `sorted.sort((a, b) => recencyAt(now, b.lifecycle?.createdAt) - recencyAt(now, a.lifecycle?.createdAt));`
- Line 103: `const rec = recencyAt(entry.lifecycle, now);`
  → `const rec = recencyAt(now, entry.lifecycle?.createdAt);`

Note the argument order flip AND the unwrap to `.createdAt`. Both matter.

**Step 3 — Rerun test, verify pass.**

```bash
npx jest tests/unit/integration/viewer/episodic 2>&1 | tail -10
```

Expected: PASS.

**Step 4 — Full suite.**

```bash
npm test 2>&1 | tail -10
```

Expected: all pass.

**Step 5 — Commit.**

```bash
git add src/integration/viewer/tabs/episodic.js tests/unit/integration/viewer/episodic-recency.test.js
git commit -m "fix(viewer): episodic tab passes createdAt to recencyAt, not lifecycle

Finding #11 (Codex 2026-04-24): episodic.js called recencyAt(lifecycle, now).
The signature is recencyAt(now, createdAt) — passing a Date/ISO string.
Passing the lifecycle object produced Invalid Date → NaN for every row,
breaking recency sorting and rendering R=NaN in the score summary.

Fix both call sites (render and sort). Regression test renders one
episodic entry and asserts R=<finite> in the .starmem-viewer-scores
text."
```

---
## Task 4: Prototype-key hardening sweep

**Objective:** Close every surface where an attacker- or LLM-controlled string can reach a `{}` map or `obj[key]` assignment that would collide with `__proto__`, `constructor`, or `prototype`. Four surfaces: persona grouping, bootstrap state backend, LLM relation targets, and Tier 3 neighbor lookups.

**Findings:** #1 (persona grouping), #2 (bootstrap chatId), #14 (LLM relation targets + tier3 lookup).

**Files:**
- Modify: `src/integration/viewer/tabs/persona.js` (groupBySubject)
- Modify: `src/integration/bootstrap.js` (buildStateBackend)
- Modify: `src/consolidation/extractFacts.js` (validateExtractionShape rejects reserved relation targets)
- Modify: `src/retrieval/tier3-graph.js` (hasOwnProperty on state.entries lookup)
- Create: `tests/unit/security/prototype-pollution.test.js`

**Step 1 — Write failing regression tests.**

Create `tests/unit/security/prototype-pollution.test.js`:

```js
/**
 * Regression for findings #1, #2, #14: reject or sanitize prototype-reserved
 * keys (__proto__, constructor, prototype) across every surface that builds
 * a map from attacker- or LLM-supplied strings.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { JSDOM } from 'jsdom';

describe('prototype pollution guards', () => {
    describe('persona grouping (finding #1)', () => {
        let dom;
        beforeEach(() => {
            dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
            globalThis.document = dom.window.document;
            globalThis.HTMLElement = dom.window.HTMLElement;
        });

        test('groups persona entries with subject="__proto__" without crashing', async () => {
            const { renderTab } = await import('../../../src/integration/viewer/tabs/persona.js');
            const entries = {
                'ps_1': makePersona('ps_1', '__proto__'),
                'ps_2': makePersona('ps_2', 'constructor'),
                'ps_3': makePersona('ps_3', 'toString'),
                'ps_4': makePersona('ps_4', 'alice'),
            };
            const parent = dom.window.document.getElementById('root');
            await expect(
                renderTab(parent, { chatId: 'c1', subjectFilter: '', state: { entries } }),
            ).resolves.not.toThrow();
            // At least one subject group rendered — no crash means the fix holds.
            const groups = parent.querySelectorAll('.starmem-viewer-persona-group');
            expect(groups.length).toBeGreaterThan(0);
        });
    });

    describe('bootstrap state backend (finding #2)', () => {
        test('write(__proto__, value) does NOT mutate Object.prototype', async () => {
            const { buildStateBackend } = await import('../../../src/integration/bootstrap.js');
            const { _setContextForTests, _resetContextForTests } =
                await import('../../../src/integration/bootstrap.js');
            const chatMetadata = {};
            _setContextForTests({ chatMetadata, saveMetadataDebounced: () => {} });
            const backend = buildStateBackend();

            const before = Object.prototype.toString;
            expect(() => backend.write('__proto__', { polluted: true })).toThrow(
                /reserved key|invalid chatId/i,
            );
            expect(Object.prototype.toString).toBe(before);
            // Ensure a clean object didn't inherit pollution.
            expect(/** @type {any} */({}).polluted).toBeUndefined();
            _resetContextForTests();
        });

        test('write(constructor, value) is rejected', async () => {
            const { buildStateBackend, _setContextForTests, _resetContextForTests } =
                await import('../../../src/integration/bootstrap.js');
            _setContextForTests({ chatMetadata: {}, saveMetadataDebounced: () => {} });
            const backend = buildStateBackend();
            expect(() => backend.write('constructor', {})).toThrow(/reserved key|invalid chatId/i);
            _resetContextForTests();
        });
    });

    describe('extractFacts relation validator (finding #14)', () => {
        test('rejects relation targets that collide with prototype keys', async () => {
            const { validateExtractionShape } = await import(
                '../../../src/consolidation/extractFacts.js'
            );
            for (const target of ['__proto__', 'constructor', 'prototype']) {
                expect(() => validateExtractionShape({
                    entries: [{
                        content: 'x', subject: null, tags: [],
                        relations: [{ type: 'mentions', target }],
                    }],
                })).toThrow(/reserved|invalid target/i);
            }
        });

        test('still accepts ordinary targets', async () => {
            const { validateExtractionShape } = await import(
                '../../../src/consolidation/extractFacts.js'
            );
            const out = validateExtractionShape({
                entries: [{
                    content: 'x', subject: null, tags: [],
                    relations: [{ type: 'mentions', target: 'ep_2026-04-24T10_abcdef012345' }],
                }],
            });
            expect(out[0].relations).toHaveLength(1);
            expect(out[0].relations[0].target).toBe('ep_2026-04-24T10_abcdef012345');
        });
    });
});

function makePersona(id, subject) {
    return {
        id, scope: 'persona', content: 'x', subject, tags: [], relations: [],
        lifecycle: {
            importance: 50, maturity: 'draft',
            createdAt: '2026-04-24T10:00:00Z', updatedAt: '2026-04-24T10:00:00Z',
            accessCount: 0, updateCount: 0,
        },
        provenance: { sourceMessages: [0], extractor: 'test@v1' },
    };
}
```

Run: `npx jest tests/unit/security/prototype-pollution 2>&1 | tail -15`
Expected: FAIL across all three describes.

**Step 2 — Fix `groupBySubject` in `src/integration/viewer/tabs/persona.js`.**

Line 57-67, replace with:

```js
function groupBySubject(entries, subjectFilter) {
    // Use a Map so subject strings like "__proto__" don't collide with
    // Object.prototype (finding #1).
    const groups = new Map();
    const q = subjectFilter.toLowerCase();
    for (const e of entries) {
        const subj = e.subject ?? '(no subject)';
        if (q && !subj.toLowerCase().includes(q)) continue;
        if (!groups.has(subj)) groups.set(subj, []);
        groups.get(subj).push(e);
    }
    return groups;
}
```

Then update the two consumers:
- Line 34: `const subjectCount = Object.keys(groups).length;` → `const subjectCount = groups.size;`
- Line 51: `for (const [subject, entries] of Object.entries(groups)) {` → `for (const [subject, entries] of groups) {`

**Step 3 — Fix `buildStateBackend` in `src/integration/bootstrap.js`.**

Replace the `buildStateBackend` function (lines 81-106) with the version below. Adds a key-sanitization helper that rejects reserved prototype keys and uses `Object.create(null)` for the nested slot map so even a missed validation wouldn't pollute.

```js
/** Reserved keys that would collide with Object.prototype if used as map keys. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Guard against prototype pollution from tampered or imported chat metadata.
 * @param {string} id
 */
function assertSafeChatId(id) {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error('[STARmem] invalid chatId (must be non-empty string)');
    }
    if (RESERVED_KEYS.has(id)) {
        throw new Error(`[STARmem] reserved key '${id}' not allowed as chatId`);
    }
}

/**
 * Build the canonical state backend that reads + writes chatMetadata via ST.
 *
 * @returns {{ read: (id: string) => unknown, write: (id: string, v: unknown) => void }}
 */
export function buildStateBackend() {
    return {
        read: (id) => {
            assertSafeChatId(id);
            const ctx = resolveContext();
            const cm = ctx?.chatMetadata;
            if (!cm || typeof cm !== 'object') return undefined;
            const slot = cm['STARmem'];
            if (!slot || typeof slot !== 'object') return undefined;
            return slot[id];
        },
        write: (id, value) => {
            assertSafeChatId(id);
            const ctx = resolveContext();
            const cm = ctx?.chatMetadata;
            if (!cm || typeof cm !== 'object') {
                throw new Error('[STARmem] chatMetadata not available — cannot persist');
            }
            if (!cm['STARmem'] || typeof cm['STARmem'] !== 'object') {
                // Object.create(null) — even if assertSafeChatId is ever
                // bypassed, prototype keys can't collide with inherited props.
                cm['STARmem'] = Object.create(null);
            }
            cm['STARmem'][id] = value;
            if (typeof ctx.saveMetadataDebounced === 'function') {
                ctx.saveMetadataDebounced();
            }
        },
    };
}
```

**Step 4 — Fix relation-target validation in `src/consolidation/extractFacts.js`.**

In `validateExtractionShape`, after the existing `if (r.type === 'contradicts')` guard at around line 138, add a reserved-key rejection before the `rels.push(...)`:

Patch line 133-145 (the relation-inner loop) so it looks like:

```js
        for (let j = 0; j < relsRaw.length; j++) {
            const r = /** @type {Record<string, unknown>} */ (relsRaw[j]);
            if (!r || typeof r !== 'object'
                || typeof r.type !== 'string'
                || typeof r.target !== 'string'
                || r.target.length === 0) {
                throw new Error(`extractFacts: entries[${i}].relations[${j}] must be { type, target }`);
            }
            if (!ALL_EDGE_TYPES.includes(/** @type {any} */ (r.type))) {
                throw new Error(`extractFacts: entries[${i}].relations[${j}].type invalid: ${r.type}`);
            }
            if (r.type === 'contradicts') {
                // Reserved per spec §4. Drop silently (forward-compatible).
                continue;
            }
            // Reject relation targets that would collide with Object.prototype
            // when later looked up as state.entries[target]. finding #14.
            if (r.target === '__proto__' || r.target === 'constructor' || r.target === 'prototype') {
                throw new Error(
                    `extractFacts: entries[${i}].relations[${j}].target uses reserved key '${r.target}'`,
                );
            }
            rels.push({ type: r.type, target: r.target });
        }
```

**Step 5 — Defense-in-depth in `src/retrieval/tier3-graph.js`.**

Even with Task 4 Step 4 in place, edges already persisted from earlier sessions could still carry reserved targets. Harden Tier 3 to skip them.

Patch `src/retrieval/tier3-graph.js` around line 65. Replace:

```js
                if (discovered.has(edge.to)) continue;
                const neighbor = state.entries[edge.to];
                if (!neighbor) continue;
```

with:

```js
                if (discovered.has(edge.to)) continue;
                // Use Object.hasOwn so reserved keys ('__proto__', 'constructor')
                // can't resolve to inherited prototype properties — defensive
                // against stored edges predating the extractFacts guard.
                if (!Object.hasOwn(state.entries, edge.to)) continue;
                const neighbor = state.entries[edge.to];
                if (!neighbor) continue;
```

**Step 6 — Run the security tests.**

```bash
npx jest tests/unit/security 2>&1 | tail -15
```

Expected: PASS — 5 tests across three describes.

**Step 7 — Full suite.**

```bash
npm test 2>&1 | tail -10
```

Expected: all pass.

**Step 8 — Commit.**

```bash
git add src/integration/viewer/tabs/persona.js src/integration/bootstrap.js \
        src/consolidation/extractFacts.js src/retrieval/tier3-graph.js \
        tests/unit/security/prototype-pollution.test.js
git commit -m "fix(security): harden four surfaces against prototype-key pollution

Findings #1, #2, #14 (Codex 2026-04-24):
  - persona.js::groupBySubject used {} as a subject→entries map. An LLM
    or tampered metadata producing subject='__proto__' or 'constructor'
    would resolve to an inherited property and throw on .push(). Switched
    to Map — no prototype chain.
  - bootstrap.js::buildStateBackend wrote to chatMetadata['STARmem'][chatId]
    with a raw chatId. Added assertSafeChatId (rejects __proto__/constructor/
    prototype) and switched the nested slot to Object.create(null).
  - extractFacts.js::validateExtractionShape accepted any non-empty string
    as a relation target. Reject the three reserved keys at validate time.
  - tier3-graph.js::tier3 looked up neighbors via state.entries[edge.to]
    without checking own-ness — any pre-existing edge with a reserved
    target could walk into Object.prototype. Gate with Object.hasOwn.

Security test: tests/unit/security/prototype-pollution.test.js covers
all three live surfaces + Tier 3 is protected defence-in-depth. Full
suite green."
```

---

## Task 5: Malformed-metadata defense (state shape, floor lifecycle, createEntry strictness, stuck flag, backend invariant)

**Objective:** Five related cleanups that harden STARmem against corrupted/imported chat metadata and restore the contract that `createEntry` produces only entries satisfying `isValidEntry`. Merged into one task because they all touch shape/validation and share a single test file.

**Findings:** #3 (graph.edges not-array), #5 (floor malformed lifecycle), #13 (stuck consolidating flag), #15 (default backend cross-chat leak), #16 (createEntry vs isValidEntry drift).

**Files:**
- Modify: `src/core/state.js` (strengthen `looksLikeState`, hard-fail default backend)
- Modify: `src/retrieval/floor.js` (lifecycle guard)
- Modify: `src/memory/entry.js` (createEntry element-level validation)
- Modify: `src/consolidation/consolidate.js` (clear stuck flag on happy path)
- Modify: tests that relied on the default backend (now must `setBackend`)
- Create: `tests/unit/security/malformed-metadata.test.js`

**Step 1 — Write failing regression tests.**

Create `tests/unit/security/malformed-metadata.test.js`:

```js
/**
 * Regressions for findings #3, #5, #13, #15, #16: corrupted or imported
 * chat metadata, and drift between createEntry and isValidEntry, must not
 * crash retrieval or produce malformed entries.
 */
import { describe, test, expect } from '@jest/globals';

describe('malformed metadata defense', () => {
    test('finding #3: Tier 3 does not crash when graph.edges is missing', async () => {
        const { retrieve } = await import('../../../src/retrieval/index.js');
        const { createEmptyState } = await import('../../../src/core/schema.js');
        const state = createEmptyState();
        // Simulate corrupted import: graph present but edges missing.
        state.graph = /** @type {any} */ ({ edges: undefined });
        expect(() => retrieve(state, 'any query', { now: new Date() })).not.toThrow();
    });

    test('finding #3: loadState rejects state with non-array graph.edges', async () => {
        const { loadState, setBackend, _resetBackendForTests } =
            await import('../../../src/core/state.js');
        const { createEmptyState } = await import('../../../src/core/schema.js');
        const malformed = { ...createEmptyState(), graph: { edges: 'not-an-array' } };
        setBackend({
            read: () => malformed,
            write: () => {},
        });
        // Malformed state → loadState returns a fresh empty state.
        const loaded = await loadState('c1');
        expect(Array.isArray(loaded.graph.edges)).toBe(true);
        expect(loaded.graph.edges).toHaveLength(0);
        _resetBackendForTests();
    });

    test('finding #5: floor() skips entries with malformed lifecycle', async () => {
        const { floor } = await import('../../../src/retrieval/floor.js');
        const state = {
            entries: {
                'ok': {
                    id: 'ok', scope: 'episodic', content: 'x', subject: null,
                    tags: [], relations: [],
                    lifecycle: {
                        importance: 50, maturity: 'draft',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        accessCount: 0, updateCount: 0,
                    },
                    provenance: { sourceMessages: [], extractor: 't' },
                },
                'bad': { id: 'bad', scope: 'episodic', content: 'y' /* lifecycle missing */ },
            },
        };
        expect(() => floor(state, { now: new Date(), k: 5 })).not.toThrow();
        const results = floor(state, { now: new Date(), k: 5 });
        expect(results.map(r => r.entry.id)).toEqual(['ok']);
    });

    test('finding #13: consolidate clears stale consolidating flag on happy-path skip', async () => {
        const { consolidate } = await import('../../../src/consolidation/consolidate.js');
        const { loadState, persistState, setBackend, _resetBackendForTests } =
            await import('../../../src/core/state.js');
        const { createEmptyState } = await import('../../../src/core/schema.js');

        let stored = { ...createEmptyState() };
        stored.runtime.consolidating = true; // simulate stuck flag
        setBackend({
            read: () => structuredClone(stored),
            write: (_id, v) => { stored = v; },
        });

        const result = await consolidate('c1', {
            profileId: 'p1', extractorLabel: 'test@v1',
            messageOf: (e) => ({ role: 'assistant', content: e.content }),
            now: new Date(),
        });
        expect(result).toEqual({ skipped: true });
        // The skipped branch must clear the flag on disk so the next trigger proceeds.
        expect(stored.runtime.consolidating).toBe(false);
        _resetBackendForTests();
    });

    test('finding #15: default backend hard-fails when bootstrap has not run', async () => {
        const { loadState, _resetBackendForTests } = await import('../../../src/core/state.js');
        _resetBackendForTests();
        // No globalThis.SillyTavern → default backend's read should throw a clear error.
        delete (/** @type {any} */ (globalThis)).SillyTavern;
        await expect(loadState('c1')).rejects.toThrow(/bootstrap|setBackend/i);
    });

    test('finding #16: createEntry rejects non-string tags', async () => {
        const { createEntry } = await import('../../../src/memory/entry.js');
        expect(() => createEntry({
            scope: 'episodic', content: 'x', subject: null,
            tags: ['ok', 42], // non-string element
            relations: [],
            provenance: { sourceMessages: [0], extractor: 't' },
            now: new Date(),
        })).toThrow(/tags.*string/i);
    });

    test('finding #16: createEntry rejects relations missing type/target', async () => {
        const { createEntry } = await import('../../../src/memory/entry.js');
        expect(() => createEntry({
            scope: 'episodic', content: 'x', subject: null, tags: [],
            relations: [{ type: 'bogus_type', target: 'ep_1' }],
            provenance: { sourceMessages: [0], extractor: 't' },
            now: new Date(),
        })).toThrow(/relation/i);
        expect(() => createEntry({
            scope: 'episodic', content: 'x', subject: null, tags: [],
            relations: [{ type: 'mentions', target: '' }],
            provenance: { sourceMessages: [0], extractor: 't' },
            now: new Date(),
        })).toThrow(/relation|target/i);
    });

    test('finding #16: createEntry rejects non-integer sourceMessages', async () => {
        const { createEntry } = await import('../../../src/memory/entry.js');
        expect(() => createEntry({
            scope: 'episodic', content: 'x', subject: null, tags: [],
            relations: [],
            provenance: { sourceMessages: [0, '1', 2.5], extractor: 't' },
            now: new Date(),
        })).toThrow(/sourceMessages/i);
    });
});
```

Run: `npx jest tests/unit/security/malformed-metadata 2>&1 | tail -20`
Expected: FAIL across all seven test cases.

**Step 2 — Strengthen `looksLikeState` in `src/core/state.js`.**

Replace the function at lines 102-112 with:

```js
function looksLikeState(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const s = /** @type {Record<string, unknown>} */ (x);
    if (typeof s.entries !== 'object' || s.entries === null || Array.isArray(s.entries)) return false;
    if (!Array.isArray(s.workingBuffer)) return false;
    // graph must be an object AND have an edges array — finding #3.
    if (typeof s.graph !== 'object' || s.graph === null) return false;
    const g = /** @type {Record<string, unknown>} */ (s.graph);
    if (!Array.isArray(g.edges)) return false;
    if (typeof s.tierCaches !== 'object' || s.tierCaches === null) return false;
    if (typeof s.runtime !== 'object' || s.runtime === null) return false;
    return true;
}
```

**Step 3 — Hard-fail the default backend in `src/core/state.js`.**

Replace `makeDefaultBackend` (lines 50-71) with:

```js
/**
 * Default backend that *throws* when invoked. Production code must call
 * setBackend(buildStateBackend()) from bootstrap before any loadState/
 * persistState call. Tests must substitute their own backend.
 *
 * Rationale (finding #15): the previous default silently read
 * globalThis.chat_metadata and wrote there without threading chatId —
 * so consolidation after a chat-switch could corrupt the wrong chat.
 * Bootstrap-must-run is now an enforced invariant instead of a comment.
 *
 * @returns {Backend}
 */
function makeDefaultBackend() {
    const err = () => new Error(
        '[STARmem] state backend not configured. Call setBackend() — '
        + 'production callers go through integration/bootstrap.js::buildStateBackend(); '
        + 'tests must inject their own.',
    );
    return {
        read: () => { throw err(); },
        write: () => { throw err(); },
    };
}
```

The `getSTContext` helper at lines 37-48 becomes dead code. Delete it.

**Step 4 — Lifecycle guard in `src/retrieval/floor.js`.**

Replace the loop body in `floor()` (lines 20-28) with:

```js
    for (const entry of Object.values(state.entries)) {
        if (!entry || entry.scope === 'working') continue;
        const lifecycle = /** @type {any} */ (entry).lifecycle;
        if (!lifecycle || typeof lifecycle !== 'object') continue;
        const { importance, maturity, createdAt } = lifecycle;
        if (typeof importance !== 'number' || typeof createdAt !== 'string') continue;
        const score = recencyAt(now, createdAt)
            * (1 + importance / 100)
            * maturityBoost(maturity);
        if (!Number.isFinite(score)) continue;
        scored.push({ entry, bm25: 0, score });
    }
```

**Step 5 — Tighten `createEntry` to match `isValidEntry` in `src/memory/entry.js`.**

After the existing validation block (around line 93, right after the provenance check and before `const when = now ?? new Date();`), add:

```js
    if (!tags.every(t => typeof t === 'string')) {
        throw new Error('createEntry: tags must be string[]');
    }
    for (let i = 0; i < relations.length; i++) {
        const r = relations[i];
        if (!r || typeof r !== 'object') {
            throw new Error(`createEntry: relations[${i}] must be an object`);
        }
        if (!isEdgeType(r.type)) {
            throw new Error(`createEntry: relations[${i}].type invalid: ${String(r.type)}`);
        }
        if (typeof r.target !== 'string' || r.target.length === 0) {
            throw new Error(`createEntry: relations[${i}].target must be a non-empty string`);
        }
    }
    if (!provenance.sourceMessages.every(n => Number.isInteger(n) && n >= 0)) {
        throw new Error('createEntry: provenance.sourceMessages must be non-negative integers');
    }
```

**Step 6 — Clear stuck flag in `consolidate.js` happy path.**

In `src/consolidation/consolidate.js`, replace the early-return block at lines 97-100 with:

```js
        // In-flight guard. If state.runtime.consolidating is already true from
        // a prior stuck/crashed run, clear it and skip — natural retry on the
        // next trigger. Finding #13: previous behaviour permanently DoS'd
        // consolidation for a chat with a stuck flag.
        if (state.runtime.consolidating === true) {
            log.warn('consolidate: stale consolidating=true on load; clearing and skipping this trigger');
            const cleared = { ...state, runtime: { ...state.runtime, consolidating: false } };
            await persistState(chatId, cleared);
            return /** @type {const} */ ({ skipped: true });
        }
```

**Step 7 — Update tests that relied on the old default backend.**

Run the suite and identify failures caused by the hard-fail default:

```bash
npm test 2>&1 | grep -E "FAIL|setBackend|bootstrap" | head -20
```

For each failing test, prepend a `setBackend(...)` call in its `beforeEach` / setup, substituting an in-memory Map-backed backend:

```js
import { setBackend, _resetBackendForTests } from '../../src/core/state.js';
// ...
let store = {};
beforeEach(() => {
    store = {};
    setBackend({
        read: (id) => store[id],
        write: (id, v) => { store[id] = v; },
    });
});
afterEach(() => _resetBackendForTests());
```

Audit systematically — check `tests/integration/` and any test that calls `loadState`/`persistState` without first calling `setBackend`. Likely candidates (based on past session memory, verify by running the suite):
- Tests under `tests/unit/consolidation/`
- Tests under `tests/unit/retrieval/` if they touch the ladder end-to-end
- Tests under `tests/integration/` that don't already go through bootstrap

**Step 8 — Run the security suite, then the full suite.**

```bash
npx jest tests/unit/security/malformed-metadata 2>&1 | tail -15
```

Expected: PASS — 7 tests.

```bash
npm test 2>&1 | tail -10
```

Expected: all pass.

**Step 9 — Commit.**

```bash
git add src/core/state.js src/retrieval/floor.js src/memory/entry.js \
        src/consolidation/consolidate.js tests/
git commit -m "fix(core): harden malformed-metadata surfaces + enforce bootstrap invariant

Five linked findings (Codex 2026-04-24):

#3 (graph.edges non-array): loadState's looksLikeState now requires
    Array.isArray(graph.edges). Tampered metadata with graph={} or
    graph.edges=null no longer crashes Tier 3 — it gets rejected at
    load and the chat starts from a fresh State.

#5 (floor malformed lifecycle): floor() now skips entries without a
    valid lifecycle object (importance:number, createdAt:string) rather
    than destructuring and throwing. Finite-score check guards against
    NaN leaks too.

#13 (stuck consolidating flag): if loadState returns state with
    runtime.consolidating=true (stale from a crash or manual edit),
    consolidate() clears the flag AND skips this trigger. Natural retry
    on the next one. Previously this permanently DoS'd consolidation
    for the chat.

#15 (default backend chatId leak): the default backend now hard-fails
    with a clear error pointing to bootstrap/setBackend. Tests injecting
    their own in-memory Map are unaffected. Bootstrap-must-run is now
    an enforced invariant rather than a comment.

#16 (createEntry vs isValidEntry drift): createEntry now enforces the
    same element-level checks as isValidEntry — tag elements must be
    strings, relations must have valid edge types + non-empty targets,
    sourceMessages must be non-negative integers.

Security test suite: tests/unit/security/malformed-metadata.test.js.
Pre-existing tests adapted to inject an in-memory backend where they
previously relied on the silent default."
```

---
## Task 6: Bounded LRU on tier caches, parametrized for sweep

**Objective:** Cap `state.tierCaches.exact` and `state.tierCaches.fuzzy` at `RETRIEVAL.TIER_CACHE_MAX_ENTRIES` (default 200). Insertion-order LRU eviction. Add the new key to `_SWEPT_RETRIEVAL_KEYS` so `setConstantOverrides({TIER_CACHE_MAX_ENTRIES: N})` works for sweeps, and the existing swept-constants guard automatically covers it.

**Finding:** #4 — `Unbounded retrieval query caching can bloat persisted state`.

**Files:**
- Modify: `src/core/constants.js` (new constant + add to `_SWEPT_RETRIEVAL_KEYS`)
- Modify: `src/retrieval/tier0-exact.js` (`recordTier0` evicts on overflow)
- Modify: `src/retrieval/tier1-fuzzy.js` (`recordTier1` evicts on overflow)
- Create: `tests/unit/retrieval/tier-cache-cap.test.js`

**Step 1 — Add the swept constant.**

In `src/core/constants.js`:

- Inside the `RETRIEVAL` object, after the `TAG_BOOST` line (around line 76), add:

```js
    /** Max entries retained per tier cache (exact and fuzzy). Oldest evicted on write. Spec §5 hardening — finding #4 (Codex 2026-04-24). Sweepable. */
    TIER_CACHE_MAX_ENTRIES: 200,
```

- In the `_SWEPT_RETRIEVAL_KEYS` frozen list (around line 186), append:

```js
    'TIER_CACHE_MAX_ENTRIES',
```

**Step 2 — Write failing test.**

Create `tests/unit/retrieval/tier-cache-cap.test.js`:

```js
/**
 * Regression for finding #4: tier caches must evict oldest entries once
 * they exceed RETRIEVAL.TIER_CACHE_MAX_ENTRIES. Parametrized so Phase 9.x
 * can sweep the cap.
 */
import { describe, test, expect, afterEach } from '@jest/globals';
import { recordTier0 } from '../../../src/retrieval/tier0-exact.js';
import { recordTier1 } from '../../../src/retrieval/tier1-fuzzy.js';
import { createEmptyState } from '../../../src/core/schema.js';
import {
    RETRIEVAL, setConstantOverrides, resetConstantOverrides,
} from '../../../src/core/constants.js';

afterEach(() => resetConstantOverrides());

function makeEntry(id) {
    return {
        id, scope: 'episodic', content: `content-${id}`, subject: null,
        tags: [], relations: [],
        lifecycle: {
            importance: 50, maturity: 'draft',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            accessCount: 0, updateCount: 0,
        },
        provenance: { sourceMessages: [], extractor: 't' },
    };
}

describe('tier 0 exact-cache eviction', () => {
    test('evicts oldest entries when exceeding TIER_CACHE_MAX_ENTRIES', () => {
        setConstantOverrides({ TIER_CACHE_MAX_ENTRIES: 5 });
        let state = createEmptyState();
        const entries = [makeEntry('e0')];
        for (let i = 0; i < 10; i++) {
            state = recordTier0(state, `query-${i}`, entries);
        }
        expect(Object.keys(state.tierCaches.exact).length).toBeLessThanOrEqual(5);
    });

    test('most recent writes are retained; oldest are dropped', () => {
        setConstantOverrides({ TIER_CACHE_MAX_ENTRIES: 3 });
        let state = createEmptyState();
        const entries = [makeEntry('e0')];
        for (let i = 0; i < 5; i++) {
            state = recordTier0(state, `query-${i}`, entries);
        }
        // The last 3 queries survive; the first 2 are evicted.
        const keys = Object.keys(state.tierCaches.exact);
        expect(keys.length).toBe(3);
        // We can't check exact cache keys (they're hashed); instead, verify
        // tier0() still hits on the latest 3 queries and misses on the oldest.
        // (Deferred to an integration test below.)
    });

    test('sweep override to TIER_CACHE_MAX_ENTRIES=1 keeps only the last write', () => {
        setConstantOverrides({ TIER_CACHE_MAX_ENTRIES: 1 });
        let state = createEmptyState();
        state = recordTier0(state, 'q1', [makeEntry('e1')]);
        state = recordTier0(state, 'q2', [makeEntry('e2')]);
        expect(Object.keys(state.tierCaches.exact).length).toBe(1);
    });
});

describe('tier 1 fuzzy-cache eviction', () => {
    test('evicts oldest entries when exceeding TIER_CACHE_MAX_ENTRIES', () => {
        setConstantOverrides({ TIER_CACHE_MAX_ENTRIES: 4 });
        let state = createEmptyState();
        const entries = [makeEntry('e0')];
        for (let i = 0; i < 10; i++) {
            // Unique-token queries so tokenSetKey differs per call.
            state = recordTier1(state, `token${i} alpha beta`, entries);
        }
        expect(Object.keys(state.tierCaches.fuzzy).length).toBeLessThanOrEqual(4);
    });
});

describe('default cap is 200', () => {
    test('RETRIEVAL.TIER_CACHE_MAX_ENTRIES defaults to 200', () => {
        expect(RETRIEVAL.TIER_CACHE_MAX_ENTRIES).toBe(200);
    });
});
```

Run: `npx jest tests/unit/retrieval/tier-cache-cap 2>&1 | tail -20`
Expected: FAIL — caches grow unbounded.

**Step 3 — Implement eviction in `src/retrieval/tier0-exact.js`.**

Replace `recordTier0` (lines 84-96):

```js
/**
 * Record a resolved query's id list in the exact cache. Bounded at
 * `RETRIEVAL.TIER_CACHE_MAX_ENTRIES` — oldest insertion-order entries are
 * evicted first when the cap is exceeded. Pure — returns a new state.
 *
 * Reading RETRIEVAL.TIER_CACHE_MAX_ENTRIES at call time (NOT destructuring
 * at module top) so sweep overrides are observed. See
 * tests/unit/core/swept-constants-overridable.test.js.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @param {import('../core/schema.js').Entry[]} entries
 * @returns {import('../core/schema.js').State}
 */
export function recordTier0(state, query, entries) {
    const key = keyFor(query);
    const ids = entries.map(e => e.id);
    // Delete-then-reinsert so the updated key moves to the end (LRU).
    // Object insertion-order is preserved per ECMA-262 §6.1.7.
    const { [key]: _discard, ...without } = state.tierCaches.exact;
    const next = { ...without, [key]: ids };
    const cap = RETRIEVAL.TIER_CACHE_MAX_ENTRIES;
    const keys = Object.keys(next);
    if (keys.length > cap) {
        // Evict the oldest (keys.length - cap) entries.
        const evicted = keys.slice(0, keys.length - cap);
        for (const k of evicted) delete next[k];
    }
    return {
        ...state,
        tierCaches: {
            ...state.tierCaches,
            exact: next,
        },
    };
}
```

Add the missing import at the top of the file if not present:

```js
import { RETRIEVAL } from '../core/constants.js';
```

**Step 4 — Implement eviction in `src/retrieval/tier1-fuzzy.js`.**

Replace `recordTier1` (lines 101-116) with the same LRU structure:

```js
/**
 * Record a resolved query's entries under its token-set key. Bounded LRU
 * at `RETRIEVAL.TIER_CACHE_MAX_ENTRIES` — oldest evicted first. Empty-token
 * queries are a no-op (returns a new state object for API consistency).
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @param {import('../core/schema.js').Entry[]} entries
 * @returns {import('../core/schema.js').State}
 */
export function recordTier1(state, query, entries) {
    const key = tokenSetKey(query);
    if (key.length === 0) {
        return { ...state };
    }
    const ids = entries.map(e => e.id);
    const { [key]: _discard, ...without } = state.tierCaches.fuzzy;
    const next = { ...without, [key]: ids };
    const cap = RETRIEVAL.TIER_CACHE_MAX_ENTRIES;
    const keys = Object.keys(next);
    if (keys.length > cap) {
        const evicted = keys.slice(0, keys.length - cap);
        for (const k of evicted) delete next[k];
    }
    return {
        ...state,
        tierCaches: {
            ...state.tierCaches,
            fuzzy: next,
        },
    };
}
```

Note: the existing `const { FUZZY_JACCARD_THRESHOLD } = RETRIEVAL;` at line 13 is fine — `FUZZY_JACCARD_THRESHOLD` is NOT swept (not in `_SWEPT_RETRIEVAL_KEYS`). No destructure of `TIER_CACHE_MAX_ENTRIES` at module top in either file.

**Step 5 — Run the cache-cap tests.**

```bash
npx jest tests/unit/retrieval/tier-cache-cap 2>&1 | tail -15
```

Expected: PASS — 5 tests.

**Step 6 — Run the swept-constants guard to confirm the new key is covered.**

```bash
npx jest tests/unit/core/swept-constants-overridable 2>&1 | tail -15
```

Expected: PASS. The guard auto-scans `src/**/*.js` for any module-top destructure of swept keys. Since we used `RETRIEVAL.TIER_CACHE_MAX_ENTRIES` at call time, the guard stays green.

Tripwire-verify the guard can catch a reintroduction: at the top of `src/retrieval/tier0-exact.js` (after the import), temporarily add `const { TIER_CACHE_MAX_ENTRIES } = RETRIEVAL;`. Re-run the swept-constants test — it MUST fail with a message naming `tier0-exact.js` and `TIER_CACHE_MAX_ENTRIES`. Then revert via `patch(old_string='const { TIER_CACHE_MAX_ENTRIES } = RETRIEVAL;\n', new_string='')` (NOT `git checkout` — there's uncommitted work in the file).

**Step 7 — Full suite.**

```bash
npm test 2>&1 | tail -10
```

Expected: all pass.

**Step 8 — Commit.**

```bash
git add src/core/constants.js src/retrieval/tier0-exact.js src/retrieval/tier1-fuzzy.js \
        tests/unit/retrieval/tier-cache-cap.test.js
git commit -m "fix(retrieval): bounded LRU on tier 0/1 caches, sweep-parametrized

Finding #4 (Codex 2026-04-24): tierCaches.exact and tierCaches.fuzzy
were recorded on every resolved query and never evicted. An attacker
or prompt-injected model issuing many unique queries would bloat chat
metadata and eventually fail the ST metadata save.

Cap each cache at RETRIEVAL.TIER_CACHE_MAX_ENTRIES (default 200).
Insertion-order LRU: on write, delete the existing key, reinsert at
tail, then evict leading keys down to cap. ECMA-262 §6.1.7 guarantees
iteration order for string keys.

The new constant is registered in _SWEPT_RETRIEVAL_KEYS so
setConstantOverrides({TIER_CACHE_MAX_ENTRIES: N}) works for Phase 9.x
sweeps. Existing swept-constants-overridable guard automatically
covers the new key — tripwire-verified by reintroducing a destructure.

Cap read at call time (not destructured at module top) so sweeps are
observed. Covered by tests/unit/retrieval/tier-cache-cap.test.js."
```

---

## Task 7: Bench tooling hardening (HTML, submissionId, customId)

**Objective:** Three bench-only findings. The codebase's threat model for bench tooling is local-only, but these are real primitives (file traversal + malformed HTML) worth closing.

**Findings:** #6 (HTML winner-cards malformed class), #7 (fireworks-warmup submissionId traversal), #8 (cache-ingest customId traversal).

**Files:**
- Modify: `bench/analyze/runs.py::_emit_html`
- Modify: `bench/harness/fireworks-warmup.js` (argv validation)
- Modify: `bench/harness/warmup/cache-ingest.js` (customId validation)
- Create: `tests/unit/bench/cache-ingest-path-traversal.test.js`
- Create: `tests/unit/bench/fireworks-warmup-submissionid.test.js`

**Step 7a — Fix cache-ingest customId traversal.**

Write failing test `tests/unit/bench/cache-ingest-path-traversal.test.js`:

```js
/**
 * Regression for finding #8: cache-ingest must reject customIds containing
 * path separators or absolute paths — they're only a basename.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestResults } from '../../../bench/harness/warmup/cache-ingest.js';

let cacheDir;

beforeEach(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'starmem-cacheingest-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

async function writeJsonl(pathArg, rows) {
    await writeFile(pathArg, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

describe('cache-ingest customId validation', () => {
    test('rejects customId containing ..', async () => {
        const resultsPath = path.join(cacheDir, 'results.jsonl');
        await writeJsonl(resultsPath, [{
            custom_id: '../../../../tmp/evil',
            response: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] },
        }]);
        const out = await ingestResults(resultsPath, {
            cacheDir, model: 'm', maxTokens: 10,
        });
        expect(out.written).toBe(0);
        expect(out.skipped).toBe(1);
        expect(out.errors[0].reason).toMatch(/path.*separator|invalid.*custom_id/i);
    });

    test('rejects customId that is an absolute path', async () => {
        const resultsPath = path.join(cacheDir, 'results.jsonl');
        await writeJsonl(resultsPath, [{
            custom_id: '/tmp/evil',
            response: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] },
        }]);
        const out = await ingestResults(resultsPath, {
            cacheDir, model: 'm', maxTokens: 10,
        });
        expect(out.written).toBe(0);
        expect(out.skipped).toBe(1);
    });

    test('accepts a hex-digest customId and writes within cacheDir', async () => {
        const resultsPath = path.join(cacheDir, 'results.jsonl');
        await writeJsonl(resultsPath, [{
            custom_id: 'a3f124cde091b7c85f00',
            response: { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] },
        }]);
        const out = await ingestResults(resultsPath, {
            cacheDir, model: 'm', maxTokens: 10,
        });
        expect(out.written).toBe(1);
        const files = await readdir(cacheDir);
        expect(files).toContain('a3f124cde091b7c85f00.json');
    });
});
```

Run: `npx jest tests/unit/bench/cache-ingest-path-traversal 2>&1 | tail -15`
Expected: FAIL on the two rejection tests (path.join silently accepts).

Fix `bench/harness/warmup/cache-ingest.js`. After the `const customId = row?.custom_id;` block (around line 59) and before the status check, add:

```js
        // Validate customId: must be a basename (no separators, not absolute).
        // Finding #8 (Codex 2026-04-24) — otherwise path.join resolves
        // arbitrary writes outside cacheDir.
        if (customId.includes('/') || customId.includes('\\')
            || customId.includes('..') || path.isAbsolute(customId)
            || customId !== path.basename(customId)) {
            skipped++;
            errors.push({ customId, reason: 'invalid custom_id (path separator or traversal)' });
            continue;
        }
```

Rerun: `npx jest tests/unit/bench/cache-ingest-path-traversal 2>&1 | tail -15` — expected PASS (3 tests).

**Step 7b — Fix fireworks-warmup submissionId traversal.**

Write failing test `tests/unit/bench/fireworks-warmup-submissionid.test.js`:

```js
/**
 * Regression for finding #7: fireworks-warmup must reject submissionIds
 * that contain path separators or are absolute paths.
 */
import { describe, test, expect } from '@jest/globals';
import { parseArgv } from '../../../bench/harness/fireworks-warmup.js';

describe('parseArgv submissionId validation', () => {
    test('rejects resume with ../ traversal', () => {
        expect(() => parseArgv(['resume', '../../../../etc'])).toThrow(/invalid submission/i);
    });

    test('rejects continue with absolute path', () => {
        expect(() => parseArgv(['continue', '/tmp/evil'])).toThrow(/invalid submission/i);
    });

    test('rejects submit --submission-id with path separator', () => {
        expect(() => parseArgv([
            'submit', '--corpora', 'locomo', '--submission-id', 'foo/bar',
        ])).toThrow(/invalid submission/i);
    });

    test('accepts ordinary hex/dash submission ids', () => {
        expect(parseArgv(['resume', 'abc123-def456']).submissionId).toBe('abc123-def456');
        expect(parseArgv(['continue', 'submission_20260424']).submissionId).toBe(
            'submission_20260424',
        );
    });
});
```

Run: `npx jest tests/unit/bench/fireworks-warmup-submissionid 2>&1 | tail -15`
Expected: FAIL — parseArgv doesn't validate.

Fix `bench/harness/fireworks-warmup.js`. At the top of the file (after imports), add:

```js
/**
 * Validate a submissionId is safe to use as a basename under SUBMISSION_ROOT.
 * Rejects path separators, `..`, and absolute paths. Finding #7.
 * @param {string} id
 */
function assertSafeSubmissionId(id) {
    if (typeof id !== 'string' || id.length === 0
        || id.includes('/') || id.includes('\\')
        || id.includes('..') || path.isAbsolute(id)
        || id !== path.basename(id)) {
        throw new Error(`invalid submission-id '${String(id)}' (must be a basename)`);
    }
}
```

Then call `assertSafeSubmissionId(out.submissionId)` and `assertSafeSubmissionId(submissionId)` at the three call sites in `parseArgv`:

- After setting `out.submissionId` in the `--submission-id` flag branch (around line 67).
- Before returning `{ command, submissionId }` for the `resume`/`continue` branches (around line 84).

Rerun: `npx jest tests/unit/bench/fireworks-warmup-submissionid 2>&1 | tail -15` — expected PASS (4 tests).

**Step 7c — Fix the HTML winner-card class interpolation.**

`bench/analyze/runs.py` lines 402-423 currently do:

```python
cls = ' class="winner"' if is_winner else ""
# ...
body_html.append(f'<tr{cls}>{tds}</tr>')       # OK: cls is a full attr
body_html.append(f'<div class="card{cls}">{card}</div>')  # BUG: nests class=
```

The `<div class="card{cls}">` interpolation produces `<div class="card class="winner">` when the row is a winner — malformed HTML.

Replace the `cls = ...` line with two variables: one for the `<tr>` (full attribute) and one for the `<div>` (class-name suffix):

```python
        is_winner = winner_idx >= 0 and row[winner_idx] == "✓"
        tr_attr = ' class="winner"' if is_winner else ""
        card_cls = " winner" if is_winner else ""
```

Then update the two appends to:

```python
        body_html.append(f'<tr{tr_attr}>{tds}</tr>')
        body_html.append(f'<div class="card{card_cls}">{card}</div>')
```

**Step 7d — Verify the HTML fix.**

Since `bench/analyze/runs.py` has Python tests (per `tests/` top-level listing), add a small assertion. If there's no existing Python test file, skip that and verify manually:

```bash
# Manual smoke: run the HTML emitter on any existing runs artifact.
# Replace with a concrete path if available.
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/STARmem-security
python3 -c "
import bench.analyze.runs as r
import polars as pl
df = pl.DataFrame({'retriever': ['ladder', 'bm25only'], 'mrr': [0.5, 0.3], 'winner': ['✓', '']})
# Patch stdout to capture
import io, sys
buf = io.StringIO()
sys.stdout = buf
r._emit_html(df)
sys.stdout = sys.__stdout__
html = buf.getvalue()
assert 'class=\"card winner\"' in html, f'expected card winner class, got: {html[:500]}'
assert 'class=\"card class=' not in html, f'nested class attrs present: {html[:500]}'
print('OK: HTML winner card class well-formed')
"
```

If `polars` or the module surface has changed, adapt the smoke to the current shape — the invariant to check is:
- `<div class="card winner">` appears in output (not `<div class="card class="winner">`).
- No substring `class="card class=` exists anywhere in the output.

**Step 7e — Full suite.**

```bash
npm test 2>&1 | tail -10
```

Expected: all pass, including both new bench tests.

**Step 7f — Commit.**

```bash
git add bench/analyze/runs.py bench/harness/fireworks-warmup.js \
        bench/harness/warmup/cache-ingest.js \
        tests/unit/bench/cache-ingest-path-traversal.test.js \
        tests/unit/bench/fireworks-warmup-submissionid.test.js
git commit -m "fix(bench): sanitize customId/submissionId, fix HTML winner-card class

Three bench tooling findings (Codex 2026-04-24):

#6: _emit_html in bench/analyze/runs.py built 'cls' as a full attribute
    string (' class=\"winner\"'), reused it inside <div class=\"card{cls}\">,
    producing malformed HTML (nested class=\"card class=\"winner\"\"). Split
    into tr_attr (full attr) and card_cls (class-name suffix).

#7: fireworks-warmup's CLI submissionId was passed to path.join(SUBMISSION_ROOT)
    unvalidated. Reject path separators, '..', and absolute paths in parseArgv.

#8: cache-ingest's customId was trusted from an external JSONL. Same
    validation: basename-only, no separators, no traversal. Malformed rows
    are skipped and reported rather than writing outside cacheDir.

All three areas have regression tests; the HTML fix is smoke-verified
because bench/analyze/runs.py has no Python test harness yet."
```

---

## Post-task: final suite + PR prep

**Step 1 — Final full green check.**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/STARmem-security
npm test 2>&1 | tail -10
npm run lint 2>&1 | tail -10
npm run typecheck 2>&1 | tail -10
```

Expected: all three green.

**Step 2 — Review the commit graph.**

```bash
git log --oneline main..HEAD
```

Expected shape (8 commits including the plan):

```
<hash> fix(bench): sanitize customId/submissionId, fix HTML winner-card class
<hash> fix(retrieval): bounded LRU on tier 0/1 caches, sweep-parametrized
<hash> fix(core): harden malformed-metadata surfaces + enforce bootstrap invariant
<hash> fix(security): harden four surfaces against prototype-key pollution
<hash> fix(viewer): episodic tab passes createdAt to recencyAt, not lifecycle
<hash> fix(integration): interceptor load→retrieve→persist is atomic
<hash> fix(memory): vendor pure-JS SHA-256, drop node:crypto for browser loading
<hash> docs(plans): security findings batch 2026-04-24
```

**Step 3 — Push + PR.**

```bash
git push -u origin fix/security-findings-batch-2026-04-24
# Then via gh or web UI, open PR against EvaL3n4/SillyTavern-STARmem main.
# PR body: link each commit to its Codex finding URL.
```

**Step 4 — After merge, drop the worktree.**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
git worktree remove ../STARmem-security
git stash pop   # restore the fireworks-warmup WIP
```

---

## Notes for executor

- **Each task ends with a commit.** Do NOT batch.
- **Run the full `npm test` after every task** — a green baseline protects against silent regressions from earlier tasks.
- **Preserve spec invariants.** Nothing in this plan adds an LLM call to the retrieval path, adds an embedding, or re-adds the fourth consolidation trigger. If an implementation step feels like it's doing any of those, stop and flag.
- **Plan-vs-reality drift.** If the actual source line numbers have shifted relative to the planning snapshot (current HEAD = 0dbe569), use the surrounding context to locate the change — the function names and structure are stable. Report any drift in the task commit message.
- **Task 5 is the largest.** Expect 2–3 rounds of `npm test` → fix one more consumer → `npm test` → commit. Other tests that implicitly relied on the silent default backend are the most likely failure mode; fix them by injecting an in-memory Map-backed backend in their setup.
- **Secrets-guard trap awareness.** Any numeric literal that looks like a credential (e.g. a tier-cache cap of 200, or an extract-max-tokens of 2048) may appear as `= ***` in tool output — that's a display artifact, not a real redaction. Verify with `awk 'NR==<line>' <file> | od -c` before patching.
