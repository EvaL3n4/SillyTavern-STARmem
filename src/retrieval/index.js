/**
 * Retrieval barrel. Single import surface for Phase 4's ladder orchestrator.
 *
 * @module retrieval
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

export { buildIndex, query, tokenize } from './bm25.js';
export { classify } from './classifier.js';
export { defaultScorer, setScorer, getScorer, _resetScorerForTests } from './scorer.js';
export { prependWorking } from './workingBuffer.js';
