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
