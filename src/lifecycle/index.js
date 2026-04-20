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
