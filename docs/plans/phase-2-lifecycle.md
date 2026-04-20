# Phase 2—Lifecycle (AKL-lite): Implementation Plan

> **For Hermes:** Controller-execute per Phase 1 retro surprise #1 (subagent `~` trap). Pure functions, no side effects, zero external deps beyond `core/schema.js` typedefs and `core/constants.js` values.

**Goal:** Land the lifecycle math from spec §7. Four pure-function modules (`recency`, `importance`, `maturity`, barrel `index`), each with golden-value tests pinning the formulas to exact numeric outputs. Nothing mutates state—these are the mathematical building blocks that Phase 3's retrieval scorer and Phase 6's consolidation will compose.

**Architecture:** One file per concern. Each function is a pure transform: takes inputs, returns new value. Lifecycle objects are treated as immutable—update functions return a new `Lifecycle` rather than mutating. All constants come from `src/core/constants.js` (already landed Phase 0). Types come from `src/core/schema.js`. No new runtime deps.

**Tech Stack:** Same as Phase 1—Node 20+, ESM, jest, ESLint 9 flat, tsc JSDoc check-only. No new devDependencies.

**Spec references:** §7 (lifecycle formulas verbatim), §5.2 (multiplicative score—shape lives in Phase 3 but Phase 2 provides the inputs).

---

## Task 0: Pre-flight

**Objective:** Confirm clean starting state from Phase 1.

**Step 1:** `cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem && git status`. Expected: `On branch main`, clean tree, last commit `docs(plans): add ST metadata API surprise to Phase 1 retro`.

**Step 2:** `npm run lint && npm run typecheck && npm run test`. Expected: all three exit 0, **46 tests pass**.

**Step 3:** Verify `src/lifecycle/.gitkeep` exists (from Phase 0 scaffold). No commit.

---

## Task 1: Recency decay — `recency.js`

**Objective:** `recencyAt(now, createdAt, tau=30) → number` in `[0, 1]`. Formula: `exp(-Δt_days / τ)`. Half-life ≈ 21 days when τ=30 (since `exp(-21/30) ≈ 0.4966`).

**Files:**
- Create: `src/lifecycle/recency.js`
- Create: `tests/unit/lifecycle/recency.test.js`

**Step 1: Write the failing test first** (`tests/unit/lifecycle/recency.test.js`):

```javascript
import { recencyAt, MS_PER_DAY } from '../../../src/lifecycle/recency.js';

describe('recencyAt', () => {
    const t0 = new Date('2026-04-20T12:00:00Z');

    test('returns 1.0 when now === createdAt', () => {
        expect(recencyAt(t0, t0)).toBeCloseTo(1.0, 6);
    });

    test('returns exp(-1) at Δt = τ days', () => {
        const thirtyLater = new Date(t0.getTime() + 30 * MS_PER_DAY);
        expect(recencyAt(thirtyLater, t0)).toBeCloseTo(Math.exp(-1), 6);  // ≈ 0.3679
    });

    test('returns ≈ 0.5 at the 21-day half-life point (τ = 30)', () => {
        const twentyOneLater = new Date(t0.getTime() + 21 * MS_PER_DAY);
        // exp(-21/30) = exp(-0.7) ≈ 0.4966
        expect(recencyAt(twentyOneLater, t0)).toBeCloseTo(0.4966, 3);
    });

    test('respects custom tau parameter', () => {
        const tenLater = new Date(t0.getTime() + 10 * MS_PER_DAY);
        // With τ=10, Δt=10 → exp(-1)
        expect(recencyAt(tenLater, t0, 10)).toBeCloseTo(Math.exp(-1), 6);
    });

    test('defaults tau to 30 when omitted', () => {
        const thirtyLater = new Date(t0.getTime() + 30 * MS_PER_DAY);
        expect(recencyAt(thirtyLater, t0)).toBe(recencyAt(thirtyLater, t0, 30));
    });

    test('decays monotonically with age', () => {
        const values = [1, 7, 14, 30, 60, 90, 365].map(d =>
            recencyAt(new Date(t0.getTime() + d * MS_PER_DAY), t0)
        );
        for (let i = 1; i < values.length; i++) {
            expect(values[i]).toBeLessThan(values[i - 1]);
        }
        expect(values.at(-1)).toBeGreaterThan(0);  // never reaches zero
        expect(values.at(-1)).toBeLessThan(0.0001);  // but gets very small
    });

    test('accepts ISO strings as well as Date objects', () => {
        const asIso = recencyAt(t0.toISOString(), t0.toISOString());
        expect(asIso).toBeCloseTo(1.0, 6);
    });

    test('treats negative Δt (now before createdAt) as Δt = 0', () => {
        // Clock skew / timezone edge case: guard against amplification.
        const earlier = new Date(t0.getTime() - 5 * MS_PER_DAY);
        expect(recencyAt(earlier, t0)).toBe(1.0);
    });

    test('rejects invalid τ', () => {
        expect(() => recencyAt(t0, t0, 0)).toThrow(/tau/);
        expect(() => recencyAt(t0, t0, -1)).toThrow(/tau/);
    });
});
```

**Step 2:** Run `npm run test tests/unit/lifecycle/recency.test.js`. Expected: FAIL (module not found).

**Step 3:** Write `src/lifecycle/recency.js`:

```javascript
/**
 * Recency decay. `recency = exp(-Δt_days / τ)`, clamped to [0, 1].
 * Used as one factor in the multiplicative retrieval score (spec §5.2).
 *
 * Guard: negative Δt (now before createdAt) is treated as Δt = 0, not
 * amplification—clock skew and timezone edges should never make an
 * entry "more than fresh."
 *
 * @module lifecycle/recency
 * @see docs/specs/2026-04-20-starmem-v2-design.md §7
 */

import { LIFECYCLE } from '../core/constants.js';

/** Milliseconds per 24-hour day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Convert a value to a Date. Accepts Date or ISO string.
 *
 * @param {Date | string} value
 * @returns {Date}
 */
function toDate(value) {
    if (value instanceof Date) return value;
    return new Date(value);
}

/**
 * Recency of an entry created at `createdAt`, evaluated at `now`.
 * Decays exponentially with half-life ≈ `τ · ln(2)` days (≈ 21 days at τ=30).
 *
 * @param {Date | string} now
 * @param {Date | string} createdAt
 * @param {number} [tau] - Decay time constant in days. Default spec §7 value.
 * @returns {number} In [0, 1]. 1.0 at Δt=0, monotonically decreasing.
 */
export function recencyAt(now, createdAt, tau = LIFECYCLE.RECENCY_TAU_DAYS) {
    if (typeof tau !== 'number' || !Number.isFinite(tau) || tau <= 0) {
        throw new Error(`recencyAt: tau must be a positive number, got ${tau}`);
    }
    const nowMs = toDate(now).getTime();
    const createdMs = toDate(createdAt).getTime();
    const deltaDays = Math.max(0, (nowMs - createdMs) / MS_PER_DAY);
    return Math.exp(-deltaDays / tau);
}
```

**Step 4:** Run `npm run test tests/unit/lifecycle/recency.test.js`. Expected: all 9 tests PASS.

**Step 5:** Run `npm run lint && npm run typecheck`. Expected: both exit 0.

**Step 6:** Commit.

```bash
git add src/lifecycle/recency.js tests/unit/lifecycle/recency.test.js
git commit -m "feat(lifecycle): add recencyAt per spec §7 (exp decay, τ=30d)"
```

---

## Task 2: Importance events — `importance.js`

**Objective:** Three pure functions updating a `Lifecycle`: `applyAccessEvent` (+3), `applyUpdateEvent` (+5, bumps `updateCount` and `updatedAt`), `applyDailyDecay(l, days)` (multiplies importance by `0.995^days`). All clamp to `[0, 100]`.

**Files:**
- Create: `src/lifecycle/importance.js`
- Create: `tests/unit/lifecycle/importance.test.js`

**Step 1: Write the failing test first:**

```javascript
import {
    applyAccessEvent,
    applyUpdateEvent,
    applyDailyDecay,
} from '../../../src/lifecycle/importance.js';

/** @type {import('../../../src/core/schema.js').Lifecycle} */
const baseLifecycle = {
    importance: 50,
    maturity: 'draft',
    createdAt: '2026-04-20T12:00:00.000Z',
    updatedAt: '2026-04-20T12:00:00.000Z',
    accessCount: 0,
    updateCount: 0,
};

describe('applyAccessEvent', () => {
    test('adds 3 to importance per spec §7', () => {
        const out = applyAccessEvent(baseLifecycle);
        expect(out.importance).toBe(53);
    });

    test('increments accessCount', () => {
        const out = applyAccessEvent(baseLifecycle);
        expect(out.accessCount).toBe(1);
    });

    test('does not mutate the input (pure function)', () => {
        applyAccessEvent(baseLifecycle);
        expect(baseLifecycle.importance).toBe(50);
        expect(baseLifecycle.accessCount).toBe(0);
    });

    test('does not touch updatedAt (access is not an update)', () => {
        const out = applyAccessEvent(baseLifecycle);
        expect(out.updatedAt).toBe(baseLifecycle.updatedAt);
    });

    test('clamps at 100', () => {
        const near = { ...baseLifecycle, importance: 99 };
        const out = applyAccessEvent(near);
        expect(out.importance).toBe(100);
    });

    test('golden value: importance=50 + 7 accesses = 71', () => {
        let l = baseLifecycle;
        for (let i = 0; i < 7; i++) l = applyAccessEvent(l);
        expect(l.importance).toBe(71);
        expect(l.accessCount).toBe(7);
    });
});

describe('applyUpdateEvent', () => {
    test('adds 5 to importance per spec §7', () => {
        const out = applyUpdateEvent(baseLifecycle, new Date('2026-04-21T12:00:00Z'));
        expect(out.importance).toBe(55);
    });

    test('increments updateCount and sets updatedAt', () => {
        const when = new Date('2026-04-21T12:00:00Z');
        const out = applyUpdateEvent(baseLifecycle, when);
        expect(out.updateCount).toBe(1);
        expect(out.updatedAt).toBe('2026-04-21T12:00:00.000Z');
    });

    test('does not increment accessCount', () => {
        const out = applyUpdateEvent(baseLifecycle, new Date());
        expect(out.accessCount).toBe(0);
    });

    test('does not mutate input', () => {
        applyUpdateEvent(baseLifecycle, new Date());
        expect(baseLifecycle.importance).toBe(50);
        expect(baseLifecycle.updateCount).toBe(0);
    });

    test('clamps at 100', () => {
        const near = { ...baseLifecycle, importance: 97 };
        const out = applyUpdateEvent(near, new Date());
        expect(out.importance).toBe(100);
    });

    test('uses current time when `now` omitted', () => {
        const before = Date.now();
        const out = applyUpdateEvent(baseLifecycle);
        const after = Date.now();
        const t = new Date(out.updatedAt).getTime();
        expect(t).toBeGreaterThanOrEqual(before);
        expect(t).toBeLessThanOrEqual(after);
    });
});

describe('applyDailyDecay', () => {
    test('multiplies importance by 0.995 for one day', () => {
        const out = applyDailyDecay(baseLifecycle, 1);
        expect(out.importance).toBeCloseTo(50 * 0.995, 6);
    });

    test('compounds over N days', () => {
        const out = applyDailyDecay(baseLifecycle, 10);
        expect(out.importance).toBeCloseTo(50 * Math.pow(0.995, 10), 6);
    });

    test('365-day convergence check: 50 decays to ~8', () => {
        const out = applyDailyDecay(baseLifecycle, 365);
        // 50 * 0.995^365 ≈ 8.05
        expect(out.importance).toBeCloseTo(50 * Math.pow(0.995, 365), 4);
        expect(out.importance).toBeGreaterThan(7);
        expect(out.importance).toBeLessThan(9);
    });

    test('zero days is a no-op', () => {
        const out = applyDailyDecay(baseLifecycle, 0);
        expect(out.importance).toBe(50);
    });

    test('negative days is rejected', () => {
        expect(() => applyDailyDecay(baseLifecycle, -1)).toThrow(/days/);
    });

    test('does not touch counts or timestamps (decay is a scheduled background effect)', () => {
        const out = applyDailyDecay(baseLifecycle, 10);
        expect(out.accessCount).toBe(baseLifecycle.accessCount);
        expect(out.updateCount).toBe(baseLifecycle.updateCount);
        expect(out.updatedAt).toBe(baseLifecycle.updatedAt);
        expect(out.createdAt).toBe(baseLifecycle.createdAt);
        expect(out.maturity).toBe(baseLifecycle.maturity);
    });

    test('does not mutate input', () => {
        applyDailyDecay(baseLifecycle, 10);
        expect(baseLifecycle.importance).toBe(50);
    });
});
```

**Step 2:** Run the test. Expected: FAIL (module not found).

**Step 3:** Write `src/lifecycle/importance.js`:

```javascript
/**
 * Importance event transforms. Pure functions returning new Lifecycle
 * objects; never mutate. Called from retrieval (access), consolidation
 * (update), and a background scheduler (daily decay).
 *
 * Formulas are spec §7 verbatim:
 * - Access: importance += 3
 * - Update: importance += 5 (+ bump updatedAt + updateCount)
 * - Daily decay: importance *= 0.995^days (≈0.5% daily)
 *
 * All results are clamped to [0, 100].
 *
 * @module lifecycle/importance
 * @see docs/specs/2026-04-20-starmem-v2-design.md §7
 */

import { LIFECYCLE } from '../core/constants.js';

/**
 * Clamp a number to the [0, 100] importance domain.
 *
 * @param {number} x
 * @returns {number}
 */
function clampImportance(x) {
    if (x < 0) return 0;
    if (x > 100) return 100;
    return x;
}

/**
 * Apply a read-access event. Bumps importance by ACCESS_BONUS and
 * increments accessCount. Does NOT touch updatedAt (access is not a
 * content mutation).
 *
 * @param {import('../core/schema.js').Lifecycle} l
 * @returns {import('../core/schema.js').Lifecycle}
 */
export function applyAccessEvent(l) {
    return {
        ...l,
        importance: clampImportance(l.importance + LIFECYCLE.ACCESS_BONUS),
        accessCount: l.accessCount + 1,
    };
}

/**
 * Apply a content-update event. Bumps importance by UPDATE_BONUS,
 * increments updateCount, and sets updatedAt to `now`.
 *
 * @param {import('../core/schema.js').Lifecycle} l
 * @param {Date} [now]
 * @returns {import('../core/schema.js').Lifecycle}
 */
export function applyUpdateEvent(l, now = new Date()) {
    return {
        ...l,
        importance: clampImportance(l.importance + LIFECYCLE.UPDATE_BONUS),
        updateCount: l.updateCount + 1,
        updatedAt: now.toISOString(),
    };
}

/**
 * Apply `days` days of compounded daily decay. Multiplies importance
 * by `DAILY_DECAY^days`. Does not touch counts, timestamps, or maturity—
 * maturity transitions are a separate concern (see `maturity.js`).
 *
 * @param {import('../core/schema.js').Lifecycle} l
 * @param {number} days - Non-negative number of days elapsed.
 * @returns {import('../core/schema.js').Lifecycle}
 */
export function applyDailyDecay(l, days) {
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
        throw new Error(`applyDailyDecay: days must be a non-negative number, got ${days}`);
    }
    if (days === 0) return { ...l };
    const factor = Math.pow(LIFECYCLE.DAILY_DECAY, days);
    return {
        ...l,
        importance: clampImportance(l.importance * factor),
    };
}
```

**Step 4:** Run the test. Expected: all 18 tests PASS.

**Step 5:** Run `npm run lint && npm run typecheck`. Expected: both exit 0.

**Step 6:** Commit.

```bash
git add src/lifecycle/importance.js tests/unit/lifecycle/importance.test.js
git commit -m "feat(lifecycle): add importance event transforms per spec §7"
```

---

## Task 3: Maturity transitions — `maturity.js`

**Objective:** Two functions. `maturityFor(importance, currentTier) → Maturity` applies hysteresis per spec §7: promote on high threshold, demote on low threshold, with gaps between them so borderline entries don't oscillate. `maturityBoost(maturity) → number` returns the multiplicative retrieval-score weight `{draft: 0.85, validated: 1.0, core: 1.2}`.

**Files:**
- Create: `src/lifecycle/maturity.js`
- Create: `tests/unit/lifecycle/maturity.test.js`

**Step 1: Write the failing test first:**

```javascript
import { maturityFor, maturityBoost } from '../../../src/lifecycle/maturity.js';

describe('maturityFor', () => {
    describe('promotion', () => {
        test('draft → validated at ι ≥ 65', () => {
            expect(maturityFor(65, 'draft')).toBe('validated');
            expect(maturityFor(64, 'draft')).toBe('draft');
            expect(maturityFor(100, 'draft')).toBe('validated');
        });

        test('validated → core at ι ≥ 85', () => {
            expect(maturityFor(85, 'validated')).toBe('core');
            expect(maturityFor(84, 'validated')).toBe('validated');
            expect(maturityFor(100, 'validated')).toBe('core');
        });

        test('draft can only step up one tier per call (ι=90, draft → validated)', () => {
            // Maturity transitions are gated: a draft entry with high importance
            // promotes to validated, not directly to core. Next call moves it
            // further if importance stays high.
            expect(maturityFor(90, 'draft')).toBe('validated');
        });
    });

    describe('demotion', () => {
        test('validated → draft at ι < 35', () => {
            expect(maturityFor(34, 'validated')).toBe('draft');
            expect(maturityFor(35, 'validated')).toBe('validated');
            expect(maturityFor(0, 'validated')).toBe('draft');
        });

        test('core → validated at ι < 60', () => {
            expect(maturityFor(59, 'core')).toBe('validated');
            expect(maturityFor(60, 'core')).toBe('core');
        });

        test('core only steps down one tier per call (ι=10, core → validated)', () => {
            expect(maturityFor(10, 'core')).toBe('validated');
        });
    });

    describe('hysteresis (gap preserved to prevent oscillation)', () => {
        test('oscillating 60 → 70 → 60 keeps validated', () => {
            // Validated stays validated until it falls below 35.
            // 60 below the promotion threshold (65) — stay.
            expect(maturityFor(60, 'validated')).toBe('validated');
            // 70 above promotion — upgrade? No: still below validated→core (85).
            expect(maturityFor(70, 'validated')).toBe('validated');
            // Back to 60 — stay.
            expect(maturityFor(60, 'validated')).toBe('validated');
        });

        test('oscillating around 35 does not flip between draft and validated', () => {
            // An entry that hit 65 and is now at 40:
            expect(maturityFor(40, 'validated')).toBe('validated');
            // Drops briefly to 36:
            expect(maturityFor(36, 'validated')).toBe('validated');
            // Back up to 40:
            expect(maturityFor(40, 'validated')).toBe('validated');
            // Only falling *below* 35 demotes:
            expect(maturityFor(34, 'validated')).toBe('draft');
        });
    });

    describe('invalid inputs', () => {
        test('rejects invalid current tier', () => {
            expect(() => maturityFor(50, /** @type {any} */ ('legendary'))).toThrow(/maturity/i);
        });

        test('rejects out-of-range importance', () => {
            expect(() => maturityFor(-1, 'draft')).toThrow(/importance/i);
            expect(() => maturityFor(101, 'draft')).toThrow(/importance/i);
        });
    });
});

describe('maturityBoost', () => {
    test('returns the spec §5.2 multipliers', () => {
        expect(maturityBoost('draft')).toBe(0.85);
        expect(maturityBoost('validated')).toBe(1.0);
        expect(maturityBoost('core')).toBe(1.2);
    });

    test('rejects invalid maturity', () => {
        expect(() => maturityBoost(/** @type {any} */ ('nope'))).toThrow(/maturity/i);
    });
});
```

**Step 2:** Run the test. Expected: FAIL.

**Step 3:** Write `src/lifecycle/maturity.js`:

```javascript
/**
 * Maturity tier transitions with hysteresis. Pure functions.
 *
 * Hysteresis (spec §7):
 *   draft → validated at ι ≥ 65
 *   validated → draft at ι < 35
 *   validated → core at ι ≥ 85
 *   core → validated at ι < 60
 *
 * The gap between promotion and demotion (65 vs 35; 85 vs 60) is
 * intentional: it prevents an entry hovering near a threshold from
 * ping-ponging between tiers on every access. Transitions are also
 * capped at one step per call—a draft with importance 95 moves to
 * validated, not straight to core.
 *
 * @module lifecycle/maturity
 * @see docs/specs/2026-04-20-starmem-v2-design.md §7, §5.2
 */

import { LIFECYCLE } from '../core/constants.js';
import { isMaturity } from '../core/schema.js';

/**
 * Compute the next maturity tier given current importance and the
 * entry's current tier. Enforces single-step transitions and hysteresis.
 *
 * @param {number} importance - In [0, 100].
 * @param {import('../core/schema.js').Maturity} currentTier
 * @returns {import('../core/schema.js').Maturity}
 */
export function maturityFor(importance, currentTier) {
    if (typeof importance !== 'number' || importance < 0 || importance > 100) {
        throw new Error(`maturityFor: importance out of range [0,100], got ${importance}`);
    }
    if (!isMaturity(currentTier)) {
        throw new Error(`maturityFor: invalid maturity tier ${String(currentTier)}`);
    }

    const { PROMOTION, DEMOTION } = LIFECYCLE;

    switch (currentTier) {
        case 'draft':
            return importance >= PROMOTION.draftToValidated ? 'validated' : 'draft';
        case 'validated':
            if (importance >= PROMOTION.validatedToCore) return 'core';
            if (importance < DEMOTION.validatedToDraft) return 'draft';
            return 'validated';
        case 'core':
            return importance < DEMOTION.coreToValidated ? 'validated' : 'core';
        /* c8 ignore next 2 */
        default:
            return currentTier;
    }
}

/**
 * Return the multiplicative score weight for a maturity tier (spec §5.2).
 *
 * @param {import('../core/schema.js').Maturity} m
 * @returns {number}
 */
export function maturityBoost(m) {
    if (!isMaturity(m)) {
        throw new Error(`maturityBoost: invalid maturity ${String(m)}`);
    }
    return LIFECYCLE.MATURITY_BOOST[m];
}
```

**Step 4:** Run the test. Expected: all tests PASS.

**Step 5:** Run `npm run lint && npm run typecheck`. Expected: both exit 0.

**Step 6:** Commit.

```bash
git add src/lifecycle/maturity.js tests/unit/lifecycle/maturity.test.js
git commit -m "feat(lifecycle): add maturity transitions with hysteresis per spec §7"
```

---

## Task 4: Barrel export — `lifecycle/index.js`

**Objective:** Single import surface for Phase 3+ consumers. `import { recencyAt, applyAccessEvent, maturityFor, maturityBoost } from '../lifecycle/index.js'` should work.

**Files:**
- Create: `src/lifecycle/index.js`
- Create: `tests/unit/lifecycle/index.test.js`

**Step 1: Write the failing test:**

```javascript
import * as lifecycle from '../../../src/lifecycle/index.js';

describe('lifecycle barrel exports', () => {
    test('exposes all public functions', () => {
        expect(typeof lifecycle.recencyAt).toBe('function');
        expect(typeof lifecycle.MS_PER_DAY).toBe('number');
        expect(typeof lifecycle.applyAccessEvent).toBe('function');
        expect(typeof lifecycle.applyUpdateEvent).toBe('function');
        expect(typeof lifecycle.applyDailyDecay).toBe('function');
        expect(typeof lifecycle.maturityFor).toBe('function');
        expect(typeof lifecycle.maturityBoost).toBe('function');
    });

    test('re-exports are reference-equal to the source modules', async () => {
        const recency = await import('../../../src/lifecycle/recency.js');
        const importance = await import('../../../src/lifecycle/importance.js');
        const maturity = await import('../../../src/lifecycle/maturity.js');
        expect(lifecycle.recencyAt).toBe(recency.recencyAt);
        expect(lifecycle.applyAccessEvent).toBe(importance.applyAccessEvent);
        expect(lifecycle.maturityFor).toBe(maturity.maturityFor);
    });
});
```

**Step 2:** Run the test. Expected: FAIL.

**Step 3:** Write `src/lifecycle/index.js`:

```javascript
/**
 * Lifecycle barrel. Single import surface for the pure-math primitives
 * that Phase 3's retrieval scorer and Phase 6's consolidation compose.
 *
 * @module lifecycle
 * @see docs/specs/2026-04-20-starmem-v2-design.md §7
 */

export { recencyAt, MS_PER_DAY } from './recency.js';
export {
    applyAccessEvent,
    applyUpdateEvent,
    applyDailyDecay,
} from './importance.js';
export { maturityFor, maturityBoost } from './maturity.js';
```

**Step 4:** Run the test. Expected: all tests PASS.

**Step 5:** Full suite: `npm run test`. Expected: all Phase 0 + Phase 1 + Phase 2 tests PASS (46 + ~35 new ≈ 81 tests).

**Step 6:** Run `npm run lint && npm run typecheck`. Expected: both exit 0.

**Step 7:** Commit.

```bash
git add src/lifecycle/index.js tests/unit/lifecycle/index.test.js
git commit -m "feat(lifecycle): add barrel export for Phase 3 consumers"
```

---

## Task 5: Phase 2 retro

**Objective:** Append a retro section to `docs/plans/ROADMAP.md`—what shipped, surprises, notes for Phase 3.

**Files:**
- Modify: `docs/plans/ROADMAP.md`

**Step 1:** Append a `## Phase 2—YYYY-MM-DD` section below the Phase 1 retro. Include:

- **What shipped:** four files (`recency.js`, `importance.js`, `maturity.js`, `index.js`) plus their unit tests. N commits. M total tests passing.
- **Surprises:** any actual surprises encountered. Candidates to watch for: jest's `toBeCloseTo` digit count interpretation, tsc narrowing with `switch` exhaustiveness, whether the `c8 ignore` comment is needed in a `checkJs`-only setup.
- **Notes for Phase 3 (Retrieval Core):**
    - BM25 index lives in `src/retrieval/bm25.js`—hand-roll per §4 "runtime dependency policy," no vendored libraries yet.
    - The multiplicative score from spec §5.2 composes `bm25 × (1 + importance/100) × recency × maturity_boost`—all four factors are now available via `src/lifecycle/index.js` plus the forthcoming BM25 function.
    - Pluggable scorer interface (spec §9.2): the default is the multiplicative formula, but the interface should let benchmark scripts swap it without code changes. A module-level `let currentScorer = defaultScorer; export function setScorer(fn)` pattern matches Phase 1's backend injection.
    - Classifier is rule-based, not LLM—spec §5 is explicit about this. Keyword/regex heuristics over three intents (factual, relational, temporal). Test 15 fixture queries per the roadmap.

**Step 2:** Replace `YYYY-MM-DD`, `N`, `M` with actual values.

**Step 3:** Commit.

```bash
git add docs/plans/ROADMAP.md
git commit -m "docs(plans): Phase 2 retro"
```

---

## Phase-boundary checklist

Before declaring Phase 2 done:

- [ ] Every formula from spec §7 has at least one golden-value test pinning its output.
- [ ] Hysteresis test (oscillation at the 60-70 boundary) passes.
- [ ] No function added mutates its inputs (pure functions only).
- [ ] No LLM calls, no retrieval, no state I/O—this phase is pure math.
- [ ] `npm run test`, `npm run lint`, `npm run typecheck` all exit 0.
- [ ] One commit per task, conventional messages, linear history.

---

## What this phase deliberately does NOT do

- **No retrieval scorer composition.** Phase 3 writes `scorer.js` that combines these four factors into the spec §5.2 multiplicative score. Phase 2 just supplies the factors.
- **No BM25, no Jaccard, no classifier.** All Phase 3.
- **No maturity *mutation* in Lifecycle.** `maturityFor` returns the next tier; applying it to a Lifecycle object is consolidation's job (Phase 6).
- **No drift detection, no influence propagation, no contradiction flagging.** Explicitly spec §11 out of scope for v2.0.
- **No daily-decay scheduler.** `applyDailyDecay` is the pure function; wiring it to a background timer happens in Phase 8 (ST integration).

If these creep in, stop and review—Phase 2's whole purpose is pure math. Keeping it scope-tight makes Phase 3's compositions trivial to write and test.
