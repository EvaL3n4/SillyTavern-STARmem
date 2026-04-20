/**
 * Retrieval barrel. Single import surface for Phase 4's ladder orchestrator
 * and Phase 5+ consumers.
 *
 * @module retrieval
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

export { buildIndex, query, tokenize } from './bm25.js';
export { classify } from './classifier.js';
export { defaultScorer, setScorer, getScorer, getScorerId, registerScorer, _resetScorerForTests } from './scorer.js';
export { prependWorking } from './workingBuffer.js';
export { tier0, recordTier0, invalidateTier0Cache, normalizeQuery, hashQuery } from './tier0-exact.js';
export { tier1, recordTier1, jaccard, tokenSetKey } from './tier1-fuzzy.js';
export { tier2 } from './tier2-bm25.js';
export { floor } from './floor.js';
export { logTrace, buildTrace } from './trace.js';
export { retrieve } from './ladder.js';
export { tier3 } from './tier3-graph.js';
