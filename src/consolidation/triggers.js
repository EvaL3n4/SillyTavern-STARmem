/**
 * Consolidation triggers. Two rules (spec §6.2, collapsed from v1's four):
 *   1. Working buffer size ≥ WORKING_BUFFER_THRESHOLD  → 'buffer' reason
 *   2. User idle ≥ IDLE_TRIGGER_SECONDS                → 'idle' reason
 *
 * Idle timer is a per-chat module-level setTimeout; the interceptor (Phase 8)
 * calls resetIdleTimer(chatId, opts) on any user activity. Timers are NOT
 * persisted — they're process state, not memory.
 *
 * maybeConsolidate checks state.runtime.consolidating before acquiring the
 * write lock to avoid queueing up runs behind one another; this is a
 * best-effort guard (the lock itself is the authority).
 *
 * @module consolidation/triggers
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.2
 */

import { loadState, persistState } from '../core/state.js';
import { withWriteLock } from '../core/lock.js';
import { CONSOLIDATION } from '../core/constants.js';
import { consolidate } from './consolidate.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('triggers');
const { WORKING_BUFFER_THRESHOLD, IDLE_TRIGGER_SECONDS } = CONSOLIDATION;

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const idleTimers = new Map();

/**
 * Fire consolidation iff the trigger condition holds and no run is already
 * in flight. Idempotent on false triggers (returns `{ skipped: true }`).
 *
 * @param {string} chatId
 * @param {'buffer' | 'idle'} reason
 * @param {import('./consolidate.js').ConsolidateOptions} opts
 * @returns {Promise<Awaited<ReturnType<typeof consolidate>> | { skipped: true, why: string }>}
 */
export async function maybeConsolidate(chatId, reason, opts) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('maybeConsolidate: chatId required');
    }
    if (reason !== 'buffer' && reason !== 'idle') {
        throw new Error(`maybeConsolidate: reason must be 'buffer' or 'idle', got ${reason}`);
    }

    const state = await loadState(chatId);

    if (state.runtime.consolidating === true) {
        return { skipped: true, why: 'already-running' };
    }
    if (state.workingBuffer.length === 0) {
        return { skipped: true, why: 'empty-buffer' };
    }

    if (reason === 'buffer' && state.workingBuffer.length < WORKING_BUFFER_THRESHOLD) {
        return { skipped: true, why: 'below-threshold' };
    }
    // 'idle' reason has no buffer-size precondition beyond non-empty (above).

    log.info(`maybeConsolidate: firing (${reason}, buffer=${state.workingBuffer.length})`);
    return consolidate(chatId, opts);
}

/**
 * (Re)start the idle timer for a chat. Clears any existing timer first.
 * When the timer elapses, fires maybeConsolidate(chatId, 'idle', opts).
 *
 * @param {string} chatId
 * @param {import('./consolidate.js').ConsolidateOptions} opts
 */
export function resetIdleTimer(chatId, opts) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('resetIdleTimer: chatId required');
    }
    const prev = idleTimers.get(chatId);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(() => {
        idleTimers.delete(chatId);
        maybeConsolidate(chatId, 'idle', opts).catch(err => {
            log.error('idle maybeConsolidate failed', /** @type {any} */ (err));
        });
    }, IDLE_TRIGGER_SECONDS * 1000);

    idleTimers.set(chatId, timer);
}

/**
 * Cancel the idle timer for a chat, if any. Used by the interceptor on chat
 * switch or extension teardown.
 *
 * @param {string} chatId
 */
export function cancelIdleTimer(chatId) {
    const prev = idleTimers.get(chatId);
    if (prev) {
        clearTimeout(prev);
        idleTimers.delete(chatId);
    }
}

/** Test-only: drop all outstanding idle timers. */
export function _resetTimersForTests() {
    for (const t of idleTimers.values()) clearTimeout(t);
    idleTimers.clear();
}

/**
 * Clear the retrieval trace ring buffer for a chat.
 * Mutation site — runs under write lock to respect the single-mutator principle.
 *
 * @param {string} chatId
 * @returns {Promise<void>}
 */
export async function clearTraces(chatId) {
    await withWriteLock(chatId, async () => {
        const state = await loadState(chatId);
        await persistState(chatId, {
            ...state,
            runtime: { ...state.runtime, traces: [] },
        });
    });
}
