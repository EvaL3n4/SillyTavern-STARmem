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
