/**
 * Atomic replacement of a subject's Persona slice. The only long-term
 * mutator in the persona-rebuild pipeline — runs under withWriteLock, swaps
 * Persona entries for the target subject in a single consistent step.
 *
 * Dangling edges from deleted Persona entries are intentionally left in
 * graph.edges: Tier 3 silently skips missing entries (Phase 4 behavior), and
 * cleaning them is not worth the extra complexity. The next consolidation or
 * rebuild can address it if it becomes a real problem.
 *
 * @module consolidation/raptor/atomic
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.4
 */

import { withWriteLock } from '../../core/lock.js';
import { loadState, persistState } from '../../core/state.js';
import { createEntry } from '../../memory/entry.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ debug: false }).scope('raptor:atomic');

/**
 * @typedef {object} PersonaReplacement
 * @property {string} text                      - The summary text to store as content.
 * @property {number[]} sourceMessages          - Concatenated source message indices for provenance.
 */

/**
 * @typedef {object} AtomicOptions
 * @property {string} chatId
 * @property {string} subject
 * @property {string} extractorLabel            - e.g. "gemma-4-31b@persona-rebuild-v1"
 * @property {PersonaReplacement[]} replacements
 * @property {Date} [now]
 * @property {AbortSignal} [signal]
 */

/**
 * Atomically replace a subject's Persona slice. Single write lock acquisition.
 *
 * On success:
 *   - All Persona entries with matching subject are deleted.
 *   - New Persona entries are created from `replacements`.
 *   - runtime.episodicCountSinceLastRebuild = 0
 *   - runtime.pendingPersonaRebuild = false
 *   - State persisted.
 *
 * On abort: throws AbortError, no state changes.
 *
 * Returns `{ deletedCount, addedCount }`.
 *
 * @param {AtomicOptions} options
 * @returns {Promise<{ deletedCount: number, addedCount: number }>}
 */
export async function atomicReplacePersona(options) {
    const { chatId, subject, extractorLabel, replacements, now, signal } = options ?? {};
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('atomicReplacePersona: chatId required');
    }
    if (typeof subject !== 'string' || subject.length === 0) {
        throw new Error('atomicReplacePersona: subject required');
    }
    if (typeof extractorLabel !== 'string' || extractorLabel.length === 0) {
        throw new Error('atomicReplacePersona: extractorLabel required');
    }
    if (!Array.isArray(replacements)) {
        throw new Error('atomicReplacePersona: replacements must be an array');
    }
    if (signal?.aborted) {
        const err = new Error('atomicReplacePersona: aborted');
        err.name = 'AbortError';
        throw err;
    }

    return withWriteLock(chatId, async () => {
        if (signal?.aborted) {
            const err = new Error('atomicReplacePersona: aborted');
            err.name = 'AbortError';
            throw err;
        }
        const state = await loadState(chatId);
        const clock = now ?? new Date();

        // Collect the ids to delete
        /** @type {string[]} */
        const toDelete = [];
        for (const [id, entry] of Object.entries(state.entries)) {
            if (entry.scope === 'persona' && entry.subject === subject) {
                toDelete.push(id);
            }
        }

        // Build the new entries
        /** @type {Record<string, import('../../core/schema.js').Entry>} */
        const newEntries = {};
        for (const r of replacements) {
            const e = createEntry({
                scope: 'persona',
                content: r.text,
                subject,
                tags: [],
                relations: [],
                provenance: {
                    sourceMessages: [...r.sourceMessages],
                    extractor: extractorLabel,
                },
                now: clock,
            });
            newEntries[e.id] = e;
        }

        // Compose the new entries map: start from existing minus deleted, add new.
        /** @type {Record<string, import('../../core/schema.js').Entry>} */
        const entriesNext = {};
        for (const [id, entry] of Object.entries(state.entries)) {
            if (!toDelete.includes(id)) entriesNext[id] = entry;
        }
        for (const [id, entry] of Object.entries(newEntries)) {
            entriesNext[id] = entry;
        }

        const next = {
            ...state,
            entries: entriesNext,
            runtime: {
                ...state.runtime,
                pendingPersonaRebuild: false,
                episodicCountSinceLastRebuild: 0,
                lastConsolidation: clock.toISOString(),
            },
        };

        await persistState(chatId, next);
        log.info(`persona rebuild for "${subject}": deleted ${toDelete.length}, added ${replacements.length}`);
        return { deletedCount: toDelete.length, addedCount: replacements.length };
    });
}
