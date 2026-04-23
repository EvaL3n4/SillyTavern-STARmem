/**
 * Corpus adapter interface.
 *
 * Every benchmark corpus (LoCoMo, LongMemEval, and future additions) implements
 * this interface. The bench harness (runner.js, sweep_app.py) is written against
 * the interface, not against any specific corpus.
 *
 * Adapters are responsible for:
 * 1. Fetching + caching raw dataset files (conventionally under bench/.cache/)
 * 2. Normalizing to `CorpusConversation[]` in deterministic order
 * 3. Exposing metadata for renderers / baseline.json writes
 *
 * Adapters are NOT responsible for:
 * - Seeding STARmem state (that's bench/harness/seeder.js)
 * - Scoring retrieval (that's bench/metrics/retrieval.js)
 * - Dispatching to Modal (that's bench/modal/sweep_app.py)
 *
 * @module bench/corpora/adapter
 */

/**
 * @typedef {object} CorpusAdapter
 * @property {string} name
 *   Canonical identifier. Matches the `--corpus` CLI flag. Must be unique.
 *   Current values: 'locomo' | 'longmemeval-s'.
 * @property {() => Promise<CorpusConversation[]>} loadConversations
 *   Returns conversations in normalized shape. Implementations handle
 *   their own fetching, caching, and normalization. MUST be deterministic
 *   across calls with the same cache state (sort order stable).
 * @property {CorpusMetadata} metadata
 *
 * @typedef {object} CorpusMetadata
 * @property {string} sourceUrl      Canonical dataset URL (HF dataset URL, GitHub raw URL, etc.)
 * @property {string} cacheKey       Relative path under bench/.cache/ (e.g. 'locomo10.json')
 * @property {number} itemCount      Expected total QA item count for sanity checks (10 convs × ~200 QA ≈ 2000 for LoCoMo; 500 for LongMemEval-S)
 * @property {string[]} [taskTypes]  Task types present, LongMemEval only
 * @property {boolean} [multiSession] True if corpus has multi-session haystacks (LongMemEval-S: true; LoCoMo: false — per Decision 8 LoCoMo's sessions are already flattened)
 *
 * @typedef {import('../loaders/locomo.js').CorpusConversation} CorpusConversation
 */

/**
 * Registry of known adapters. Populated at import time by
 * bench/corpora/index.js's barrel.
 *
 * @type {Map<string, CorpusAdapter>}
 */
const REGISTRY = new Map();

/**
 * Register a corpus adapter. Called by each adapter's module-load side effect.
 *
 * @param {CorpusAdapter} adapter
 */
export function registerAdapter(adapter) {
    if (!adapter || typeof adapter.name !== 'string' || adapter.name.length === 0) {
        throw new Error(`registerAdapter: adapter must have a non-empty name, got ${JSON.stringify(adapter)}`);
    }
    if (typeof adapter.loadConversations !== 'function') {
        throw new Error(`registerAdapter(${adapter.name}): loadConversations must be a function`);
    }
    if (!adapter.metadata || typeof adapter.metadata.sourceUrl !== 'string') {
        throw new Error(`registerAdapter(${adapter.name}): metadata.sourceUrl required`);
    }
    REGISTRY.set(adapter.name, adapter);
}

/**
 * Retrieve an adapter by name. Throws on unknown name to surface config
 * typos early (e.g. `--corpus locomo10` vs `locomo`).
 *
 * @param {string} name
 * @returns {CorpusAdapter}
 */
export function getAdapter(name) {
    const adapter = REGISTRY.get(name);
    if (!adapter) {
        const known = Array.from(REGISTRY.keys()).sort().join(', ') || '(none registered)';
        throw new Error(`getAdapter: unknown corpus ${JSON.stringify(name)}. Known: ${known}`);
    }
    return adapter;
}

/**
 * List all registered adapter names.
 * @returns {string[]}
 */
export function listAdapters() {
    return Array.from(REGISTRY.keys()).sort();
}

/**
 * Test helper: clear the registry. Adapters re-register on re-import;
 * tests that want isolated registries should use jest.resetModules().
 */
export function _clearRegistryForTests() {
    REGISTRY.clear();
}
