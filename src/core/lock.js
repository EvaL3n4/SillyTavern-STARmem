/**
 * Per-chat async write lock. Spec §2 principle 2 says "one path per
 * responsibility…many readers, single mutator." This module is that
 * single mutator's gatekeeper: every long-term mutation must flow
 * through `withWriteLock`.
 *
 * Implementation: a `Map<chatId, Promise<void>>` of tail promises.
 * Each call appends an awaiter to the chain and returns the caller's
 * eventual result. Errors in one call do not poison the chain.
 *
 * @module core/lock
 */

/** @type {Map<string, Promise<void>>} */
const tails = new Map();

/**
 * Run `fn` in mutual exclusion with any other `withWriteLock` call for
 * the same `chatId`. Independent chatIds run in parallel.
 *
 * @template T
 * @param {string} chatId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withWriteLock(chatId, fn) {
    if (typeof fn !== 'function') {
        return Promise.reject(new Error('withWriteLock: fn must be a function'));
    }
    if (typeof chatId !== 'string' || chatId.length === 0) {
        return Promise.reject(new Error('withWriteLock: chatId must be a non-empty string'));
    }

    const prev = tails.get(chatId) ?? Promise.resolve();
    // The next tail waits for prev to settle, then runs fn. We swallow prev's
    // rejection for chain-continuity but let fn's result propagate to the caller.
    const run = prev.catch(() => {}).then(() => fn());
    // The tail only tracks completion (not value) so its type matches Map signature.
    const tail = run.then(() => {}, () => {});
    tails.set(chatId, tail);
    // Clean up the Map once this tail settles, but only if it's still the latest.
    tail.finally(() => {
        if (tails.get(chatId) === tail) {
            tails.delete(chatId);
        }
    });
    return run;
}

/**
 * Clear all in-flight lock state. Test-only escape hatch. Never call
 * this from production code; any pending `withWriteLock` callers will
 * still execute, but their serialization guarantee is voided.
 */
export function _resetLocksForTests() {
    tails.clear();
}
