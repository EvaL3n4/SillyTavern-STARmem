/**
 * State I/O. Bridges STARmem's in-memory State tree to SillyTavern's
 * chatMetadata slot. The backend is injectable so unit tests substitute
 * an in-memory Map for ST globals.
 *
 * Spec §3 says the entire STARmem tree lives at chatMetadata['STARmem'].
 * The canonical extension API is `SillyTavern.getContext()`, which returns
 * `{ chatMetadata, saveMetadataDebounced, ... }`. ST swaps the active
 * chatMetadata object when the user switches chats, so we resolve it on
 * every read/write rather than caching a reference.
 *
 * ChatId is the lock key (see core/lock.js) and a log discriminator, not
 * a storage key—the backend reads whatever is current on the getContext
 * return value.
 *
 * @module core/state
 * @see docs/specs/2026-04-20-starmem-v2-design.md §3
 */

import { createEmptyState } from './schema.js';

/**
 * @typedef {object} Backend
 * @property {(chatId: string) => unknown} read   - Returns raw stored value or undefined.
 * @property {(chatId: string, value: unknown) => void} write
 */

/**
 * Default backend that *throws* when invoked. Production code must call
 * setBackend(buildStateBackend()) from bootstrap before any loadState/
 * persistState call. Tests must substitute their own backend.
 *
 * Rationale (finding #15): the previous default silently read
 * globalThis.chat_metadata and wrote there without threading chatId —
 * so consolidation after a chat-switch could corrupt the wrong chat.
 * Bootstrap-must-run is now an enforced invariant instead of a comment.
 *
 * @returns {Backend}
 */
function makeDefaultBackend() {
    const err = () => new Error(
        '[STARmem] state backend not configured. Call setBackend() — '
        + 'production callers go through integration/bootstrap.js::buildStateBackend(); '
        + 'tests must inject their own.',
    );
    return {
        read: () => { throw err(); },
        write: () => { throw err(); },
    };
}

/** @type {Backend} */
let backend = makeDefaultBackend();

/**
 * Replace the storage backend. Callers are the SillyTavern integration
 * layer (Phase 8) on startup, and unit tests.
 *
 * @param {Backend} b
 */
export function setBackend(b) {
    if (!b || typeof b.read !== 'function' || typeof b.write !== 'function') {
        throw new Error('setBackend: backend must expose read() and write()');
    }
    backend = b;
}

/** Test-only: restore the default backend. */
export function _resetBackendForTests() {
    backend = makeDefaultBackend();
}

/**
 * Shape-check for State. Loose—rejects primitives and arrays, accepts
 * any object with the five top-level keys. Deep validation happens at
 * use-sites (isValidEntry when indexing, etc.).
 *
 * @param {unknown} x
 * @returns {boolean}
 */
function looksLikeState(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const s = /** @type {Record<string, unknown>} */ (x);
    if (typeof s.entries !== 'object' || s.entries === null || Array.isArray(s.entries)) return false;
    if (!Array.isArray(s.workingBuffer)) return false;
    // graph must be an object AND have an edges array — finding #3.
    if (typeof s.graph !== 'object' || s.graph === null) return false;
    const g = /** @type {Record<string, unknown>} */ (s.graph);
    if (!Array.isArray(g.edges)) return false;
    if (typeof s.tierCaches !== 'object' || s.tierCaches === null) return false;
    if (typeof s.runtime !== 'object' || s.runtime === null) return false;
    return true;
}

/**
 * Load STARmem state for a chat. Returns a fresh empty State if nothing
 * is stored or the stored value is malformed. Always returns a deep-
 * cloned object independent of the backend's storage.
 *
 * @param {string} chatId
 * @returns {Promise<import('./schema.js').State>}
 */
export async function loadState(chatId) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('loadState: chatId must be a non-empty string');
    }
    const raw = backend.read(chatId);
    if (!looksLikeState(raw)) {
        return createEmptyState();
    }
    return /** @type {import('./schema.js').State} */ (structuredClone(raw));
}

/**
 * Persist STARmem state for a chat. Caller is responsible for holding
 * the write lock (see core/lock.js); this function does not acquire it.
 *
 * @param {string} chatId
 * @param {import('./schema.js').State} state
 * @returns {Promise<void>}
 */
export async function persistState(chatId, state) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('persistState: chatId must be a non-empty string');
    }
    if (!looksLikeState(state)) {
        throw new Error('persistState: state does not match expected shape');
    }
    backend.write(chatId, structuredClone(state));
}
