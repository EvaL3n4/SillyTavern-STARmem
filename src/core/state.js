/**
 * State I/O. Bridges STARmem's in-memory State tree to SillyTavern's
 * chatMetadata['STARmem'] slot. The backend is injectable so unit tests
 * substitute an in-memory Map for ST globals.
 *
 * Spec §3 says the entire STARmem tree lives at chatMetadata['STARmem'].
 * ChatId is the lock key (see core/lock.js) and a log discriminator, not
 * a storage key—ST swaps the active chatMetadata when the user switches
 * chats, so our default backend reads whatever is current.
 *
 * @module core/state
 * @see docs/specs/2026-04-20-starmem-v2-design.md §3
 */

import { createEmptyState } from './schema.js';

const METADATA_KEY = 'STARmem';

/**
 * @typedef {object} Backend
 * @property {(chatId: string) => unknown} read   - Returns raw stored value or undefined.
 * @property {(chatId: string, value: unknown) => void} write
 */

/** @returns {Backend} */
function makeDefaultBackend() {
    return {
        read: (_chatId) => {
            const meta = /** @type {Record<string, unknown> | undefined} */ (
                /** @type {any} */ (globalThis).chat_metadata
            );
            return meta?.[METADATA_KEY];
        },
        write: (_chatId, value) => {
            const g = /** @type {any} */ (globalThis);
            g.chat_metadata = g.chat_metadata ?? {};
            g.chat_metadata[METADATA_KEY] = value;
            if (typeof g.saveMetadataDebounced === 'function') {
                g.saveMetadataDebounced();
            }
        },
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
    return (
        typeof s.entries === 'object' && s.entries !== null && !Array.isArray(s.entries)
        && Array.isArray(s.workingBuffer)
        && typeof s.graph === 'object' && s.graph !== null
        && typeof s.tierCaches === 'object' && s.tierCaches !== null
        && typeof s.runtime === 'object' && s.runtime !== null
    );
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
