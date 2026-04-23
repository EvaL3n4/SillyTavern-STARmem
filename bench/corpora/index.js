/**
 * Corpus adapter barrel. Imports every adapter's module (registering it
 * as a side effect) and re-exports the registry API for consumers.
 *
 * @module bench/corpora
 */

// Adapter registrations happen at import time via module-load side effect.
import './locomo.js';
import './longmemeval.js';  // Uncommented in Phase 12 Task 3

export { getAdapter, listAdapters, registerAdapter } from './adapter.js';
export { locomoAdapter, loadLocomo, CANONICAL_URL as LOCOMO_URL } from './locomo.js';
export { longmemevalSAdapter, loadLongMemEvalS, CANONICAL_URL as LONGMEMEVAL_S_URL } from './longmemeval.js';
