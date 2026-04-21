# Sub-phase 9.4.5 — Entry-ID Determinism

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task. Spec compliance review after each task, code quality review after spec passes. Proceed only when both reviews approve.

**Goal:** Make `generateEntryId` deterministic by deriving its suffix from a content seed (sha256 → 12 hex chars) instead of `Math.random()`, so that re-running the bench seeder on the same corpus produces identical `stateHash` and `factCount`. Unblocks Tasks 5–10 of sub-phase 9.5, which depend on comparable stateHashes across sweep points.

**Architecture:** `src/memory/entry.js` currently composes an id as `<prefix>_<iso>_<randomHex3>`, where the suffix is `Math.random()`. Under replay of identical consolidation inputs, suffixes differ → map keys differ → downstream state tree ordering, edge builds, and dedup paths all drift → `stateHash` is unreproducible. 9.4.5 replaces the random suffix with `sha256(seed).slice(0, 12)` where `seed` is a stable string over the entry's distinguishing fields (scope, content, subject, sorted tags, source-message indices, extractor). `createEntry` computes the seed and passes it to `generateEntryId`; all call sites inherit determinism transparently.

**Tech Stack:** Node 25 `node:crypto` `createHash('sha256')`. Zero runtime deps. ES2022 modules throughout.

---

## Context: why this is 9.4.5, not 9.5.X

Sub-phase 9.5 Task 4 (live-extraction smoke on LoCoMo conv 1) surfaced the bug:

- Rule-based baseline, identical inputs, two runs:
  - Run 1: `factCount=374, stateHash=9dfc08608e27`
  - Run 2: `factCount=375, stateHash=f923d843bc7a`
- Live run (cold → warm → warm): three distinct stateHashes, three distinct factCounts
- Cache itself is deterministic (100% hit rate on 2nd warm run, same LLM responses)

Preliminary diagnosis in `docs/bench/sweeps/2026-04-21-smoke-live.md` §Verdict:
> Preliminary diagnosis: `src/memory/entry.js` `randomSuffix()` generates random 3-char hex IDs, causing entry-ID collisions that alter deduplication and final state counts. This is a pre-existing bug outside Tasks 1–3 scope.

Phase-9.5 sweeps (Tasks 5–10) depend on structurally comparable stateHashes across sweep points to reason about knob effects. Running sweeps on top of random-ID noise produces metric surfaces we can't interpret. 9.4.5 slots in chronologically *after* the 9.5 infrastructure tasks (0–4) but *before* the sweep tasks (5–10), because only the smoke revealed the need.

---

## Decisions locked before writing this plan (conversation 2026-04-21)

1. **Suffix derivation.** sha256(seed) truncated to 12 hex chars (48 bits). Matches the 12-char stateHash convention used in existing sweep docs; 3-hex would collide under birthday paradox around ~80 entries even with sha256-derived bytes.
2. **Seed composition.** `${scope}|${content}|${subject ?? ''}|${tags.sort().join(',')}|${sourceMessages.join(',')}|${extractor}`. Everything that distinguishes two facts. Tags sorted for insertion-order stability.
3. **`generateEntryId` signature.** Becomes `generateEntryId(scope, now, seed)` — `seed` required. Breaks the export surface; tests updated in the same commit.
4. **Regression test location.** `tests/unit/memory/determinism.test.js` (Eva's ask). Pure unit test on `createEntry` / `generateEntryId` — same-input → same-output, different-input → different-output. End-to-end seeder re-run is a one-time manual verification, documented but not committed as a test.
5. **Scope of fix.** `src/memory/entry.js` `randomSuffix()` only. `src/consolidation/personaRebuild.js` uses `Date.now()` inside collection IDs; Task 1 audits whether this lands in persisted state (and therefore stateHash). If yes, fix rolls into Task 2; if no (transient logging only), note in retro and defer.
6. **Collision policy.** Two entries with fully-identical seeds (same scope, content, subject, tags, sourceMessages, extractor) collapse to the same id. That's correct — dedup would merge them anyway — and the update path in `consolidate.js` handles the id collision gracefully (overwrites existing, bumps lifecycle).
7. **Id length.** `<prefix>_<iso>_<12hex>` = `ep_2026-04-20T14:12:33_a3f124cde091` → 30 chars. Up from 22 under the current 3-hex scheme. Fine for storage + logs.

---

## Inherited contracts

- `src/memory/entry.js` exports `createEntry({...})`, `isValidEntry(x)`, `generateEntryId(scope, now)`.
- `src/memory/index.js` re-exports all three; consumed downstream by consolidation, retrieval tests, and the viewer.
- `createEntry` is called from: `src/consolidation/extractFacts.js:199`, `src/consolidation/raptor/atomic.js:97`, `src/integration/bootstrap.js:167`, `bench/harness/seeder.js:165`.
- `generateEntryId` is **only** called from `createEntry` in production source. Tests call it directly at `tests/unit/memory/entry.test.js` and probe for its existence at `tests/unit/memory/index.test.js:8`.

The signature change is contained: `createEntry`'s public API does not change (seed is computed internally). Only direct `generateEntryId` callers need updating, and they all live in `tests/unit/memory/`.

---

## Task overview

| # | File(s) | What | Est. LOC |
|---|---|---|---|
| 0 | `docs/plans/phase-9-4-5-id-determinism.md` | Plan file commit | — |
| 1 | Audit doc (new): `docs/bench/audits/2026-04-21-determinism-audit.md` | Scan for other non-determinism sources | artifact |
| 2 | `src/memory/entry.js` | sha256-seeded suffix; signature change | ~30 delta |
| 3 | `tests/unit/memory/entry.test.js` | Update test surface for new signature | ~20 delta |
| 4 | `tests/unit/memory/determinism.test.js` (new) | Regression test — same input → same id | ~100 |
| 5 | `docs/bench/sweeps/2026-04-21-smoke-determinism.md` (new) | Re-run conv 1 smoke, record stateHash stability | artifact |
| 6 | `docs/plans/phase-9-4-5-retro.md` (new) | Retro + handoff notes for 9.5 Tasks 5–10 | artifact |

Plan size target: ~450 lines. Single-file fix with thorough preflight and regression coverage.

---

## Task 0: Commit the plan

**Objective:** Land this plan file so the rest of 9.4.5 has a stable reference.

**Files:**
- Commit: `docs/plans/phase-9-4-5-id-determinism.md`

**Step 1: Verify plan file exists and is complete**

```bash
wc -l docs/plans/phase-9-4-5-id-determinism.md
grep -c "^## Task " docs/plans/phase-9-4-5-id-determinism.md
```

Expected: ~450 lines, exactly 7 task headings (0–6).

**Step 2: Verify no secrets-guard redactions**

```bash
grep -n '=\s*\*\*\*\|=\*\*\*' docs/plans/phase-9-4-5-id-determinism.md
```

Expected: empty output.

**Step 3: Commit**

```bash
git add docs/plans/phase-9-4-5-id-determinism.md
git commit -m "docs(plans): sub-phase 9.4.5 entry-id determinism plan"
```

---

## Task 1: Audit other non-determinism sources

**Objective:** Before touching `entry.js`, confirm that the `randomSuffix` fix is sufficient. Scan for other `Math.random`, `Date.now()`, and un-injected `new Date()` calls in the consolidation/state write path and document whether they contaminate persisted state.

**Files:**
- Create: `docs/bench/audits/2026-04-21-determinism-audit.md`

**Step 1: Scan for all randomness sources in `src/`**

```bash
grep -rn "Math\.random\|crypto\.randomUUID\|crypto\.randomBytes" src/ --include='*.js'
```

Expected output (known baseline):
```
src/memory/entry.js:23:    return Math.floor(Math.random() * 0x1000).toString(16).padStart(3, '0');
```

If any other hits appear, each one must be classified in the audit doc as either:
- **Contaminating** (output lands in persisted state) → fix rolls into Task 2
- **Transient** (logging, metrics, rate-limit jitter) → noted and deferred

**Step 2: Scan for `Date.now()` and un-injected `new Date()` in write-path code**

```bash
grep -rn "new Date()\|Date\.now()" src/ --include='*.js' | grep -v "// " | grep -v "opts\.now\|= now ?? "
```

Expected hits requiring audit:
- `src/consolidation/personaRebuild.js:100` — `const startTime = Date.now()` (used for duration metric; transient)
- `src/consolidation/personaRebuild.js:129` — `starmem:${chatId}:${subject}:persona-rebuild:${depth}:${Date.now()}` (embedded in collection id)
- `src/consolidation/personaRebuild.js:230` — `duration: Date.now() - startTime` (metric, transient)
- `src/integration/bootstrap.js:72` — `now: new Date()` (app-startup bootstrap, not in bench path)
- `src/integration/bootstrap.js:166` — `const now = new Date()` (same)
- `src/integration/viewer/tabs/episodic.js:71` — `const now = new Date()` (UI render-time, not persisted)
- `src/integration/viewer/tabs/persona.js:161` — `now: new Date()` (UI render-time)
- `src/integration/viewer/tabs/traces.js:61` — `new Date().toISOString()` (export filename, not persisted)
- `src/integration/interceptor.js:108` — `send_date: new Date().toISOString()` (ST-side message timestamp, user-facing)
- `src/integration/interceptor.js:156` — `retrieve(state, query, { now: new Date() })` (read path, no state mutation)

**Step 3: Classify `personaRebuild.js:129` collection id**

This is the one that might land in persisted state. Trace its usage:

```bash
grep -n "collectionId\|rebuild-\|persona-rebuild" src/consolidation/personaRebuild.js
grep -rn "collectionId" src/ tests/ --include='*.js'
```

Decision rule:
- If `collectionId` is written into `state.persona.*` or `state.runtime.*` in any mutation path, it contaminates stateHash → Task 2 fix includes replacing `Date.now()` in that id with a deterministic counter or content hash.
- If `collectionId` is only used transiently (log label, in-memory metric key discarded after the rebuild), document as transient and defer.

**Step 4: Write the audit doc**

Create `docs/bench/audits/2026-04-21-determinism-audit.md`:

```markdown
# Determinism Audit — 2026-04-21

Ran before Task 2 of sub-phase 9.4.5 to confirm the `randomSuffix` fix is sufficient.

## Randomness sources in `src/`

| File:Line | Call | Classification | Action |
|---|---|---|---|
| `src/memory/entry.js:23` | `Math.random()` → entry id suffix | **Contaminating** — embedded in `entry.id`, keys every state map | Fixed in Task 2 |

(Expected exactly 1 hit. If more surfaced, rows added here.)

## Time sources in write-path code

| File:Line | Call | Classification | Action |
|---|---|---|---|
| `src/consolidation/personaRebuild.js:100` | `Date.now()` | Transient — `startTime` local, used only for duration metric | Deferred |
| `src/consolidation/personaRebuild.js:129` | `Date.now()` in `collectionId` | See Step 3 result below | See below |
| `src/consolidation/personaRebuild.js:230` | `Date.now()` | Transient — duration metric | Deferred |
| `src/integration/bootstrap.js:*` | `new Date()` | App-startup, not in bench path | Deferred |
| `src/integration/viewer/tabs/*.js` | `new Date()` | UI render-time, not persisted | Deferred |
| `src/integration/interceptor.js:108` | `new Date()` | ST-side message metadata, user-facing, out of STARmem state | Deferred |
| `src/integration/interceptor.js:156` | `new Date()` | Passed as `opts.now` to read-path `retrieve`; no state mutation | Deferred |

## `personaRebuild.js:129` collectionId classification

[Filled in after Step 3 trace. Either "contaminating, rolled into Task 2" or "transient, deferred to Phase 11".]

## Summary

Exactly one contaminating source identified: `src/memory/entry.js:23`. Task 2 proceeds with a single-file fix. [If personaRebuild.js:129 is contaminating, amend Task 2 scope to include it and update this summary.]
```

**Step 5: Commit**

```bash
git add docs/bench/audits/2026-04-21-determinism-audit.md
git commit -m "docs(bench): determinism audit — confirm randomSuffix is the only contaminator"
```

---

## Task 2: SHA-256-seeded entry id

**Objective:** Replace `randomSuffix()` with `contentSuffix(seed)` that returns `sha256(seed).slice(0, 12)`. Update `generateEntryId` signature to take `seed`. Update `createEntry` to compute seed from entry fields and pass it through.

**Files:**
- Modify: `src/memory/entry.js`

**Pre-flight: lock the seed composition**

The seed string is built from the fields that distinguish two facts:

```
seed = `${scope}|${content}|${subject ?? ''}|${tags.sort().join(',')}|${sourceMessages.join(',')}|${extractor}`
```

- `scope`: `working` | `episodic` | `persona`
- `content`: entry content (may contain pipes; fine, pipes aren't meta-characters in sha256)
- `subject`: may be null; normalized to empty string
- `tags`: sorted to stabilize insertion-order variance from the extractor
- `sourceMessages`: integer indices, joined with `,`
- `extractor`: extractor id string from provenance

**Step 1: Write the failing test first** (updating existing tests happens in Task 3 — this step is for a NEW property test in the same file-level test suite)

Append to `tests/unit/memory/entry.test.js`:

```javascript
    describe('generateEntryId determinism (9.4.5)', () => {
        const now = new Date('2026-04-20T14:12:33Z');

        test('same seed → same suffix', () => {
            const a = generateEntryId('episodic', now, 'seed-A');
            const b = generateEntryId('episodic', now, 'seed-A');
            expect(a).toBe(b);
        });

        test('different seed → different suffix', () => {
            const a = generateEntryId('episodic', now, 'seed-A');
            const b = generateEntryId('episodic', now, 'seed-B');
            expect(a).not.toBe(b);
        });

        test('suffix is 12 lowercase-hex characters', () => {
            const id = generateEntryId('episodic', now, 'seed-A');
            const suffix = id.split('_').pop();
            expect(suffix).toMatch(/^[a-f0-9]{12}$/);
        });

        test('missing seed throws', () => {
            expect(() => generateEntryId('episodic', now)).toThrow(/seed/i);
            expect(() => generateEntryId('episodic', now, '')).toThrow(/seed/i);
        });
    });
```

**Step 2: Run the test to verify failure**

```bash
npm test -- tests/unit/memory/entry.test.js
```

Expected: FAILs for the new 4 tests — `generateEntryId` does not yet accept a seed and its suffix is 3 hex chars.

**Step 3: Implement the sha256-seeded suffix**

Patch `src/memory/entry.js`. Replace the `randomSuffix` function, the `generateEntryId` function, and the `createEntry` call site.

Replace lines 18–40 (the comment block + `randomSuffix` + `generateEntryId`) with:

```javascript
import { createHash } from 'node:crypto';
import { isScope, isMaturity, isEdgeType } from '../core/schema.js';

/** Scope → id prefix. */
const SCOPE_PREFIX = Object.freeze({
    working: 'wk',
    episodic: 'ep',
    persona: 'ps',
});

/**
 * Derive a 12-hex-char suffix from a content seed. Deterministic: same seed
 * always produces the same suffix, so replayed extractions on identical
 * inputs yield identical entry ids. 12 hex chars = 48 bits, ~281T values —
 * collision-safe for any realistic corpus size.
 *
 * @param {string} seed
 * @returns {string}
 */
function contentSuffix(seed) {
    return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

/**
 * Generate an entry id of the form `<prefix>_<iso>_<suffix>`, e.g.
 * `ep_2026-04-20T14:12:33_a3f124cde091`. ISO timestamp is trimmed to
 * second precision; suffix is sha256(seed).slice(0,12).
 *
 * @param {import('../core/schema.js').Scope} scope
 * @param {Date} now
 * @param {string} seed - Content-derived stable string, see contentSuffix.
 * @returns {string}
 */
export function generateEntryId(scope, now, seed) {
    if (!isScope(scope)) {
        throw new Error(`generateEntryId: invalid scope ${String(scope)}`);
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('generateEntryId: now must be a valid Date');
    }
    if (typeof seed !== 'string' || seed.length === 0) {
        throw new Error('generateEntryId: seed required (non-empty string)');
    }
    const iso = now.toISOString().replace(/\.\d+Z$/, '');
    return `${SCOPE_PREFIX[scope]}_${iso}_${contentSuffix(seed)}`;
}
```

Then update `createEntry` (currently around line 86) to compute the seed and pass it. Find:

```javascript
    return {
        id: generateEntryId(scope, when),
```

Replace with:

```javascript
    const seed = [
        scope,
        content,
        subject ?? '',
        [...tags].sort().join(','),
        provenance.sourceMessages.join(','),
        provenance.extractor,
    ].join('|');

    return {
        id: generateEntryId(scope, when, seed),
```

**Step 4: Run the new determinism tests — expect pass**

```bash
npm test -- tests/unit/memory/entry.test.js
```

Expected: the 4 new determinism tests pass. **The existing test at line 16–22 (`appends a short random suffix…`) FAILS now** — it was asserting non-equality for same-second ids, which is no longer true when fields are identical. That test gets rewritten in Task 3.

**Step 5: Do NOT commit yet**

Task 3 fixes the old test; commit after both are green together.

---

## Task 3: Update existing entry tests for new signature

**Objective:** Replace the old "random suffix" test with one that asserts the new deterministic contract, and update any other tests whose assumptions break.

**Files:**
- Modify: `tests/unit/memory/entry.test.js`

**Step 1: Replace the obsolete test**

Find (around line 16–22):

```javascript
        test('appends a short random suffix to disambiguate same-second IDs', () => {
            const now = new Date('2026-04-20T14:12:33Z');
            const a = generateEntryId('episodic', now);
            const b = generateEntryId('episodic', now);
            expect(a).not.toBe(b);
            // suffix is last 3 chars after final underscore
            expect(a.split('_').pop()).toHaveLength(3);
        });
```

Replace with:

```javascript
        test('appends a deterministic 12-hex-char suffix derived from seed', () => {
            const now = new Date('2026-04-20T14:12:33Z');
            const a = generateEntryId('episodic', now, 'seed-A');
            const b = generateEntryId('episodic', now, 'seed-A');
            expect(a).toBe(b);
            expect(a.split('_').pop()).toHaveLength(12);
            expect(a.split('_').pop()).toMatch(/^[a-f0-9]+$/);
        });
```

**Step 2: Update the other `generateEntryId` tests to pass a seed**

Find (around line 4–14):

```javascript
        test('prefixes episodic entries with ep_', () => {
            const id = generateEntryId('episodic', new Date('2026-04-20T14:12:33Z'));
            expect(id.startsWith('ep_2026-04-20T14:12:33')).toBe(true);
        });

        test('prefixes working with wk_ and persona with ps_', () => {
            const now = new Date('2026-04-20T14:12:33Z');
            expect(generateEntryId('working', now).startsWith('wk_')).toBe(true);
            expect(generateEntryId('persona', now).startsWith('ps_')).toBe(true);
        });
```

Replace with:

```javascript
        test('prefixes episodic entries with ep_', () => {
            const id = generateEntryId('episodic', new Date('2026-04-20T14:12:33Z'), 'seed');
            expect(id.startsWith('ep_2026-04-20T14:12:33')).toBe(true);
        });

        test('prefixes working with wk_ and persona with ps_', () => {
            const now = new Date('2026-04-20T14:12:33Z');
            expect(generateEntryId('working', now, 'seed').startsWith('wk_')).toBe(true);
            expect(generateEntryId('persona', now, 'seed').startsWith('ps_')).toBe(true);
        });
```

**Step 3: Run the full entry.test.js — expect all pass**

```bash
npm test -- tests/unit/memory/entry.test.js
```

Expected: all tests pass, including the 4 new determinism tests from Task 2.

**Step 4: Run the full suite — expect all pass**

```bash
npm test
```

Expected: 70 suites / 744 tests green (Phase 9.5 baseline 740 + 4 new determinism tests from Task 2 Step 1). No regressions elsewhere — `createEntry`'s signature is unchanged, so consolidation/retrieval/integration tests are unaffected.

If any test fails with an id-shape assertion (e.g. `expect(id).toMatch(/_[a-f0-9]{3}$/)`), it's hard-coded the old 3-hex pattern. Update to `/_[a-f0-9]{12}$/`.

**Step 5: Lint + typecheck**

```bash
npm run lint
npm run typecheck
```

Expected: both green. JSDoc types on `generateEntryId` were updated in Task 2 to include the `seed` param.

**Step 6: Commit Task 2 + Task 3 together**

```bash
git add src/memory/entry.js tests/unit/memory/entry.test.js
git commit -m "fix(memory): sha256-seeded deterministic entry ids (9.4.5)

Replace randomSuffix() with sha256(seed).slice(0, 12) where seed is
derived from the entry's distinguishing fields (scope, content, subject,
sorted tags, sourceMessages, extractor). Identical consolidation inputs
now produce identical entry ids, which keeps state maps/edges/dedup
paths stable under replay.

Fixes the stateHash drift that appeared in the Phase 9.5 conv-1 smoke
(rule-based: 374 vs 375 facts, hash 9dfc08608e27 vs f923d843bc7a).

generateEntryId signature is now (scope, now, seed) — seed required.
Callers are createEntry (internal) and 3 tests in tests/unit/memory/.
createEntry's public API is unchanged."
```

---

## Task 4: Determinism regression test

**Objective:** Lock in the invariant with a dedicated unit test at `tests/unit/memory/determinism.test.js` (Eva's requested location). The test proves same-input → same-id across fresh `createEntry` calls and across a batch sequence.

**Files:**
- Create: `tests/unit/memory/determinism.test.js`

**Step 1: Write the test**

Create `tests/unit/memory/determinism.test.js`:

```javascript
/**
 * Regression test for sub-phase 9.4.5 entry-id determinism.
 *
 * Motivated by the Phase 9.5 conv-1 smoke: identical consolidation inputs
 * produced different stateHashes (374 vs 375 facts, 9dfc08608e27 vs
 * f923d843bc7a) because randomSuffix() used Math.random(). This test
 * locks in the sha256(seed)-derived suffix so it can't regress silently.
 *
 * @see docs/plans/phase-9-4-5-id-determinism.md
 * @see docs/bench/sweeps/2026-04-21-smoke-live.md (the motivating finding)
 */
import { createEntry, generateEntryId } from '../../../src/memory/entry.js';

describe('entry id determinism', () => {
    const now = new Date('2026-04-20T14:12:33Z');

    /** @type {Parameters<typeof createEntry>[0]} */
    const baseFields = {
        scope: 'episodic',
        content: 'Alice grew up in Marseille and moved to Paris at 18.',
        subject: 'alice',
        tags: ['location', 'hometown'],
        provenance: { sourceMessages: [42, 43], extractor: 'test@v1' },
        now,
    };

    describe('createEntry — same fields, same id', () => {
        test('two entries with identical fields collapse to the same id', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({ ...baseFields });
            expect(a.id).toBe(b.id);
        });

        test('differs on content', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({ ...baseFields, content: baseFields.content + '.' });
            expect(a.id).not.toBe(b.id);
        });

        test('differs on subject', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({ ...baseFields, subject: 'bob' });
            expect(a.id).not.toBe(b.id);
        });

        test('differs on scope', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({ ...baseFields, scope: 'persona' });
            expect(a.id).not.toBe(b.id);
            expect(a.id.slice(0, 2)).toBe('ep');
            expect(b.id.slice(0, 2)).toBe('ps');
        });

        test('differs on sourceMessages', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({
                ...baseFields,
                provenance: { sourceMessages: [42, 44], extractor: 'test@v1' },
            });
            expect(a.id).not.toBe(b.id);
        });

        test('differs on extractor', () => {
            const a = createEntry({ ...baseFields });
            const b = createEntry({
                ...baseFields,
                provenance: { sourceMessages: [42, 43], extractor: 'live@gemma4' },
            });
            expect(a.id).not.toBe(b.id);
        });

        test('tag insertion order does not change id', () => {
            const a = createEntry({ ...baseFields, tags: ['location', 'hometown'] });
            const b = createEntry({ ...baseFields, tags: ['hometown', 'location'] });
            expect(a.id).toBe(b.id);
        });

        test('null subject and empty-string subject yield the same id', () => {
            const a = createEntry({ ...baseFields, subject: null });
            const b = createEntry({ ...baseFields, subject: '' });
            // Subject normalization: null → '' in the seed. If this ever
            // changes, the seed spec below also changes.
            expect(a.id).toBe(b.id);
        });
    });

    describe('generateEntryId — seed contract', () => {
        test('12-hex suffix is stable across calls', () => {
            const a = generateEntryId('episodic', now, 'seed-1');
            const b = generateEntryId('episodic', now, 'seed-1');
            expect(a).toBe(b);
            expect(a.split('_').pop()).toMatch(/^[a-f0-9]{12}$/);
        });

        test('distinct seeds yield distinct suffixes', () => {
            const ids = new Set();
            for (let i = 0; i < 1000; i++) {
                ids.add(generateEntryId('episodic', now, `seed-${i}`));
            }
            expect(ids.size).toBe(1000);
        });

        test('different times with same seed yield different ids', () => {
            const t1 = new Date('2026-04-20T14:12:33Z');
            const t2 = new Date('2026-04-20T14:12:34Z');
            expect(generateEntryId('episodic', t1, 's')).not.toBe(
                generateEntryId('episodic', t2, 's'),
            );
        });
    });

    describe('batch determinism — replay produces identical id sequence', () => {
        function buildBatch() {
            const contents = [
                'Alice moved to Paris at 18.',
                'Bob started learning guitar last year.',
                'Carol ran a marathon in October.',
                'Dave adopted a cat named Miso.',
                'Eve started her PhD in linguistics.',
            ];
            return contents.map((content, i) =>
                createEntry({
                    scope: 'episodic',
                    content,
                    subject: null,
                    tags: [],
                    provenance: { sourceMessages: [i], extractor: 'test@v1' },
                    now,
                }),
            );
        }

        test('two independent batch constructions produce identical id sequences', () => {
            const a = buildBatch().map(e => e.id);
            const b = buildBatch().map(e => e.id);
            expect(a).toEqual(b);
        });

        test('every id in a batch is unique (no false collisions on distinct content)', () => {
            const ids = buildBatch().map(e => e.id);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });
});
```

**Step 2: Run the test — expect pass**

```bash
npm test -- tests/unit/memory/determinism.test.js
```

Expected: 13 tests pass.

**Step 3: Run the full suite — expect all pass**

```bash
npm test
```

Expected: 71 suites / 757 tests green (Task 3 ended at 744; this task adds 13).

**Step 4: Lint + typecheck**

```bash
npm run lint
npm run typecheck
```

Expected: both green.

**Step 5: Commit**

```bash
git add tests/unit/memory/determinism.test.js
git commit -m "test(memory): lock in 9.4.5 entry-id determinism invariant"
```

---

## Task 5: Smoke re-verification on LoCoMo conv 1

**Objective:** Re-run the end-to-end smoke from 9.5 Task 4 (conv 1, rule-based + live-cached) and record stateHashes. Expected: identical stateHash + factCount across back-to-back runs for each extractor.

**Files:**
- Create: `docs/bench/sweeps/2026-04-21-smoke-determinism.md`

**Step 1: Pre-reqs**

- Repo on `main` at the commit from Task 4.
- LiteLLM / Gemma endpoint reachable only for the live portion. If unreachable, skip live portion and proceed with rule-based only; note in the doc.

**Step 2: Rule-based smoke — run twice**

```bash
# Run 1
node bench/cli.js --conversations 1 --output /tmp/smoke-det-rb-1.json
# Run 2 (fresh)
node bench/cli.js --conversations 1 --output /tmp/smoke-det-rb-2.json

# Compare stateHash and factCount
jq '.runs[0].stateHash, .runs[0].factCount' /tmp/smoke-det-rb-1.json
jq '.runs[0].stateHash, .runs[0].factCount' /tmp/smoke-det-rb-2.json
```

Expected: identical `stateHash` and identical `factCount` across runs 1 and 2.

If not identical, Task 1's audit missed a contaminator. Re-open audit, identify, patch, re-run.

**Step 3: Live-cached smoke — run twice (cache already warm from 9.5 Task 4)**

```bash
# Run 1
STARMEM_BENCH_LIVE_EXTRACTOR=1 \
  STARMEM_BENCH_LLM_URL=... \
  STARMEM_BENCH_LLM_API_KEY=... \
  STARMEM_BENCH_LLM_MODEL=... \
  node bench/cli.js --conversations 1 --output /tmp/smoke-det-live-1.json

# Run 2 (fresh)
STARMEM_BENCH_LIVE_EXTRACTOR=1 \
  STARMEM_BENCH_LLM_URL=... \
  STARMEM_BENCH_LLM_API_KEY=... \
  STARMEM_BENCH_LLM_MODEL=... \
  node bench/cli.js --conversations 1 --output /tmp/smoke-det-live-2.json

jq '.runs[0].stateHash, .runs[0].factCount' /tmp/smoke-det-live-1.json
jq '.runs[0].stateHash, .runs[0].factCount' /tmp/smoke-det-live-2.json
```

Expected: identical `stateHash` and identical `factCount`. Cache is 100%-hit from prior runs; any drift here is non-determinism we missed.

**Step 4: Write the smoke doc**

Create `docs/bench/sweeps/2026-04-21-smoke-determinism.md`:

```markdown
# Determinism smoke — 2026-04-21 (post-9.4.5)

**Corpus:** LoCoMo conv 1 only (1 conversation, ~199 QA items, 82 consolidation triggers)
**Model:** google/gemma-4-26b-a4b-it via nano-gpt.com (live portion only)
**Purpose:** Confirm sub-phase 9.4.5's sha256-seeded entry ids produce identical stateHash and factCount across replays.

## Rule-based (pre-9.4.5 baseline, from 2026-04-21-smoke-live.md)
- Run 1: factCount=374, stateHash=9dfc08608e27
- Run 2: factCount=375, stateHash=f923d843bc7a
- Verdict: drift, confirming the bug.

## Rule-based (post-9.4.5)
- Run 1: factCount=XXX, stateHash=XXXXXXXXXXXX
- Run 2: factCount=XXX, stateHash=XXXXXXXXXXXX
- Verdict: [identical | drift — investigate]

## Live-cached (post-9.4.5)
- Run 1: factCount=XXX, stateHash=XXXXXXXXXXXX
- Run 2: factCount=XXX, stateHash=XXXXXXXXXXXX
- Verdict: [identical | drift — investigate]

## Conclusion
[If both pairs match:] Determinism restored. Phase 9.5 Tasks 5–10 unblocked.
[If either drifts:] Residual non-determinism. File follow-up, do NOT proceed to sweeps.
```

Fill in the actual values from Steps 2–3.

**Step 5: Commit**

```bash
git add docs/bench/sweeps/2026-04-21-smoke-determinism.md
git commit -m "docs(bench): 9.4.5 post-fix determinism smoke"
```

---

## Task 6: Retro and 9.5 handoff

**Objective:** Capture findings, decisions, and handoff notes for 9.5 Tasks 5–10.

**Files:**
- Create: `docs/plans/phase-9-4-5-retro.md`

**Step 1: Write the retro**

Create `docs/plans/phase-9-4-5-retro.md`:

```markdown
# Sub-phase 9.4.5 Retro — Entry-ID Determinism

**Status:** [Complete | Deferred — reason]
**Commits:** [list commit shas from Tasks 0–5]

## What happened

Sub-phase 9.5 Task 4 smoke on LoCoMo conv 1 revealed that identical consolidation inputs produced different stateHashes and factCounts across back-to-back runs (even with a 100%-hit extraction cache). Preliminary diagnosis pointed at `src/memory/entry.js` `randomSuffix()` using `Math.random()`. 9.4.5 was inserted to fix the contaminator before the 9.5 sweep tasks.

## Decisions held

1. Suffix derivation — sha256(seed).slice(0,12). Held.
2. Seed composition — scope|content|subject|sortedTags|sourceMessages|extractor. Held.
3. generateEntryId signature — (scope, now, seed) with required seed. Held.
4. Regression test location — tests/unit/memory/determinism.test.js. Held.
5. Scope — only randomSuffix() in entry.js. [Held | revised to also fix personaRebuild.js collectionId — see Task 1 audit.]
6. Collision policy — identical fields collapse to same id. Held.
7. Id length — prefix + iso + 12hex = 30 chars. Held.

## What worked

- Task 1 audit caught [N] additional non-determinism sources before writing code.
- sha256(seed) is a one-line swap; no ripple through consolidation/retrieval.
- `createEntry`'s public API unchanged, so downstream tests needed zero updates.
- Determinism regression test covers createEntry, generateEntryId, and batch-replay.
- End-to-end smoke confirmed identical stateHash across rule-based and live-cached.

## What surprised us

[Fill in during execution. Candidates: test count diff from what plan predicted, secondary non-determinism sources caught by Task 1, subject-normalization edge case in the seed spec.]

## Notes for sub-phase 9.5 Tasks 5–10

- Entry ids are now deterministic under content replay. Sweep stateHashes at different knob values are comparable iff the knobs don't themselves alter which facts get extracted. For extraction-altering knobs (EXTRACT_MAX_TOKENS, consolidation buffer size), expect stateHash to differ across sweep points — that's the signal, not a bug.
- The determinism invariant assumes `extractor` is in the seed. Any new extractor shipped later must identify itself in `provenance.extractor` or ids will collide with existing facts.
- Entry ids are 30 chars now. Any log-truncation or id-display UI that assumed 22 chars needs updating. Grep `src/integration/viewer/` for hard-coded lengths before shipping v2.0.
- `personaRebuild.js` collection ids [still use Date.now() | now deterministic]. See Task 1 audit classification.
- Baseline.json's `gitSha` pin of `4afaea02` is now stale. 9.5 Task 11 should repin to the 9.4.5 final commit plus the 9.5 sweep commits.

## Metrics

- Plan length: ~450 lines (target)
- Duration: [hh:mm]
- Tests added: 4 (Task 2 inline) + 13 (Task 4 regression) = 17
- Tests changed: 3 (Task 3 existing entry tests updated for new signature)
- Files touched: 2 source (src/memory/entry.js, tests/unit/memory/entry.test.js), 1 new test, 1 new audit, 1 new smoke doc, 2 new plan/retro docs
```

Fill in the bracketed sections during execution.

**Step 2: Commit**

```bash
git add docs/plans/phase-9-4-5-retro.md
git commit -m "docs(plans): sub-phase 9.4.5 retro"
```

**Step 3: Final verification**

```bash
npm test              # expect: all green
npm run lint          # expect: green
npm run typecheck     # expect: green
git log --oneline -10 # expect: 5 new 9.4.5 commits stacked on 9.5 Task 3 (f1587f9)
```

---

## Done. 9.5 Tasks 5–10 now unblocked.
