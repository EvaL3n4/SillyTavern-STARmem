/**
 * Consolidation barrel. Phase 8's interceptor and settings UI import from here.
 *
 * @module consolidation
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6
 */

export { consolidate } from './consolidate.js';
export { extractFacts } from './extractFacts.js';
export { findDuplicate, jaccard } from './dedup.js';
export { callLLM } from './llmClient.js';
export { rebuildPersona } from './personaRebuild.js';
export {
    maybeConsolidate, resetIdleTimer, cancelIdleTimer,
} from './triggers.js';
