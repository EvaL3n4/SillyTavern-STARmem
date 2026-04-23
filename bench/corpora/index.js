/**
 * Corpus adapter barrel. Imports every adapter's module (registering it
 * as a side effect) and re-exports the registry API for consumers.
 *
 * @module bench/corpora
 */

// Adapter registrations happen at import time via module-load side effect.
import './locomo.js';
// import './longmemeval.js'; // uncomment when Task 3 lands

export { getAdapter, listAdapters, registerAdapter } from './adapter.js';
export { locomoAdapter, loadLocomo, CANONICAL_URL } from './locomo.js';
