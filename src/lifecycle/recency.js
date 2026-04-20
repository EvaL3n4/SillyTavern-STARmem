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
