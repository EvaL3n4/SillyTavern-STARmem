/**
 * consolidate() — the ONE function that mutates long-term storage.
 *
 * Per spec §2 principle 2: "One path per responsibility. ... Many readers,
 * single mutator." This is that single mutator. Any other code that writes
 * to state.entries (beyond the working-buffer append path) or state.graph
 * is a spec violation.
 *
 * Pipeline (spec §6.3):
 *   acquire write_lock
 *   mark state.runtime.consolidating = true
 *   take batch = workingBuffer[0:r] (r = CONSOLIDATION.BATCH_SIZE)
 *   entries = extractFacts(batch-as-messages, context)
 *   for each extracted entry:
 *     if findDuplicate in episodic corpus:
 *       applyUpdateEvent on the existing entry (importance += 5, updateCount += 1)
 *     else:
 *       add entry (scope already 'episodic' from extractFacts)
 *       buildEdges → apply newEdges + evicted inside the lock
 *       increment episodicCountSinceLastRebuild; flip pendingPersonaRebuild at threshold
 *   splice workingBuffer[0:r]
 *   invalidateTier0Cache(state)  (ONCE at end of batch per §5 cache rules)
 *   persistState
 *   clear consolidating flag, release lock
 *
 * Error handling: any exception (LLM call, parse, validate) releases the lock
 * *without* draining the buffer or persisting any changes. Natural retry on
 * the next trigger. No partial state.
 *
 * @module consolidation/consolidate
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.3, §2 principle 2
 */

import { withWriteLock } from '../core/lock.js';
import { loadState, persistState } from '../core/state.js';
import { CONSOLIDATION } from '../core/constants.js';
import { addEdge, removeEdge, buildEdges } from '../memory/index.js';
import { applyUpdateEvent } from '../lifecycle/index.js';
import { invalidateTier0Cache } from '../retrieval/tier0-exact.js';
import { logTrace } from '../retrieval/trace.js';
import { extractFacts, ExtractionParseError } from './extractFacts.js';
import { findDuplicate } from './dedup.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('consolidation');

// PERSONA_REBUILD_SUGGESTION_THRESHOLD is NOT swept — module-top destructure
// is fine (snapshot at import matches production behavior).
//
// BATCH_SIZE IS swept (9.4.9) — must be read through CONSOLIDATION at call
// time so setConstantOverrides() is observed. See:
//   docs/plans/phase-9-4-9-graph-consolidation-sweeps.md Task 1
//   tests/unit/core/swept-constants-overridable.test.js (destructure guard)
const { PERSONA_REBUILD_SUGGESTION_THRESHOLD } = CONSOLIDATION;

/**
 * @typedef {object} ConsolidateOptions
 * @property {string} profileId          - ST connection profile for extractor.
 * @property {string} extractorLabel     - Human-readable extractor identifier.
 * @property {(entry: import('../core/schema.js').Entry) => {role: string, content: string}} messageOf
 *            - Maps a Working entry to a batch message for the extractor prompt.
 * @property {Date} [now]                - Injectable clock for deterministic tests.
 */

/**
 * Consolidate the working buffer into Episodic. Idempotent when run on an
 * empty buffer (no-op fast path). At most one run per chatId concurrently
 * (guarded by state.runtime.consolidating + withWriteLock).
 *
 * @param {string} chatId
 * @param {ConsolidateOptions} opts
 * @returns {Promise<{ added: number, updated: number, drained: number, parseFailures: number, entriesSkipped: number } | { skipped: true }>}
 */
export async function consolidate(chatId, opts) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('consolidate: chatId required');
    }
    if (!opts || typeof opts !== 'object') {
        throw new Error('consolidate: options required');
    }
    const { profileId, extractorLabel, messageOf, now } = opts;
    if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('consolidate: opts.profileId required');
    }
    if (typeof extractorLabel !== 'string' || extractorLabel.length === 0) {
        throw new Error('consolidate: opts.extractorLabel required');
    }
    if (typeof messageOf !== 'function') {
        throw new Error('consolidate: opts.messageOf required');
    }

    return withWriteLock(chatId, async () => {
        const startedAt = Date.now();
        const state = await loadState(chatId);

        // In-flight guard. If state.runtime.consolidating is already true from
        // a prior stuck/crashed run, clear it and skip — natural retry on the
        // next trigger. Finding #13: previous behaviour permanently DoS'd
        // consolidation for a chat with a stuck flag.
        if (state.runtime.consolidating === true) {
            log.warn('consolidate: stale consolidating=true on load; clearing and skipping this trigger');
            const cleared = { ...state, runtime: { ...state.runtime, consolidating: false } };
            await persistState(chatId, cleared);
            return /** @type {const} */ ({ skipped: true });
        }

        // Empty-buffer fast path
        if (state.workingBuffer.length === 0) {
            return { added: 0, updated: 0, drained: 0, parseFailures: 0, entriesSkipped: 0 };
        }

        // Capture the batch *before* any mutation — if extract fails, we never
        // touch the buffer.
        const r = Math.min(CONSOLIDATION.BATCH_SIZE, state.workingBuffer.length);
        const batchIds = state.workingBuffer.slice(0, r);
        /** @type {import('../core/schema.js').Entry[]} */
        const batchEntries = [];
        for (const id of batchIds) {
            const e = state.entries[id];
            if (e) batchEntries.push(e);
        }
        if (batchEntries.length === 0) {
            // Buffer references missing ids — drop the stale references and
            // continue. This is the one case where we WRITE on an empty batch,
            // but it's a cleanup, not a long-term mutation.
            log.warn('consolidate: working buffer references missing entries; cleaning stale ids');
            const s1 = { ...state, workingBuffer: state.workingBuffer.slice(r) };
            await persistState(chatId, s1);
            return { added: 0, updated: 0, drained: r, parseFailures: 0, entriesSkipped: 0 };
        }

        // Build the LLM prompt messages from batch entries
        const batchMessages = batchEntries.map(messageOf);
        const sourceMessageIndices = batchEntries.flatMap(e => e.provenance.sourceMessages);

        // Mark in-flight BEFORE calling the LLM so the flag is persisted even
        // if the process crashes mid-extraction. We only persist at the end,
        // so the flag is actually carried by the next mutation — but since we
        // hold the write lock throughout, no reader can observe a half-written
        // state.
        let work = { ...state, runtime: { ...state.runtime, consolidating: true } };

        /** @type {{ entries: import('../core/schema.js').Entry[], skipped: number }} */
        let extracted;
        try {
            extracted = await extractFacts(batchMessages, {
                profileId,
                extractorLabel,
                sourceMessageIndices,
                now,
            });
        } catch (err) {
            // Phase 12 Task 7: parse failures are content-level (model
            // emitted malformed/truncated JSON), not transport-level.
            // Treat them as "0 facts extracted" rather than aborting:
            // drain the buffer, persist, return parseFailures=1 so the
            // bench harness can report rate. Aborting on parse failure
            // would leave the buffer over-threshold → next turn re-fires
            // → same cached bad response → infinite loop on cache replay.
            if (err instanceof ExtractionParseError) {
                log.warn(
                    `consolidate: extraction parse failed (responseLength=${err.responseLength ?? '?'}); ` +
                    `dropping batch of ${batchEntries.length} entries`,
                );
                const clock = now ?? new Date();
                const trace = {
                    kind: 'consolidate',
                    timestamp: clock.toISOString(),
                    chatId,
                    summary: {
                        factCount: 0,
                        added: 0,
                        updated: 0,
                        scope: 'episodic',
                        error: 'parse_failure',
                    },
                    durationMs: Date.now() - startedAt,
                    extractor: extractorLabel,
                };
                let drained = {
                    ...state,
                    workingBuffer: state.workingBuffer.slice(r),
                    runtime: {
                        ...state.runtime,
                        consolidating: false,
                        lastConsolidation: clock.toISOString(),
                    },
                };
                drained = logTrace(drained, trace);
                await persistState(chatId, drained);
                return { added: 0, updated: 0, drained: r, parseFailures: 1, entriesSkipped: 0 };
            }
            // Transport / validation / unknown — original behavior:
            // abort, release lock, no mutation persisted, buffer intact.
            log.error('consolidate: extraction failed, aborting batch', /** @type {any} */(err));
            // Clear the consolidating flag on disk in case a prior run left
            // it set. Cheap, idempotent.
            if (state.runtime.consolidating) {
                const cleared = { ...state, runtime: { ...state.runtime, consolidating: false } };
                await persistState(chatId, cleared);
            }
            throw err;
        }

        let added = 0;
        let updated = 0;
        const clock = now ?? new Date();

        for (const newEntry of extracted.entries) {
            const allExisting = Object.values(work.entries);
            const dup = findDuplicate(newEntry, allExisting);
            if (dup) {
                // Update path: bump lifecycle only. Keep existing content, tags,
                // relations, id, provenance. Spec §6.3 option A.
                const bumped = {
                    ...dup,
                    lifecycle: applyUpdateEvent(dup.lifecycle, clock),
                };
                work = {
                    ...work,
                    entries: { ...work.entries, [dup.id]: bumped },
                };
                updated++;
            } else {
                // Add path. newEntry is already scope='episodic' from extractFacts.
                work = {
                    ...work,
                    entries: { ...work.entries, [newEntry.id]: newEntry },
                };
                // Build edges using the post-add state + full Entry[] corpus
                const corpus = Object.values(work.entries);
                const { newEdges, evicted } = buildEdges(newEntry, corpus, work);
                for (const e of newEdges) work = addEdge(work, e);
                for (const e of evicted) work = removeEdge(work, e.from, e.to, e.type);

                added++;
            }
        }

        // Counter + Persona rebuild flag
        if (added > 0) {
            const nextCount = (work.runtime.episodicCountSinceLastRebuild ?? 0) + added;
            const nextPending = work.runtime.pendingPersonaRebuild
                || nextCount >= PERSONA_REBUILD_SUGGESTION_THRESHOLD;
            work = {
                ...work,
                runtime: {
                    ...work.runtime,
                    episodicCountSinceLastRebuild: nextCount,
                    pendingPersonaRebuild: nextPending,
                },
            };
        }

        // Drain batch from working buffer
        work = { ...work, workingBuffer: work.workingBuffer.slice(r) };

        // Invalidate Tier 0 cache once at end of batch (spec §5)
        work = invalidateTier0Cache(work);

        // Close the run
        work = {
            ...work,
            runtime: {
                ...work.runtime,
                consolidating: false,
                lastConsolidation: clock.toISOString(),
            },
        };

        const trace = {
            kind: 'consolidate',
            timestamp: clock.toISOString(),
            chatId,
            summary: {
                factCount: extracted.entries.length,
                added,
                updated,
                scope: 'episodic',
            },
            durationMs: Date.now() - startedAt,
            extractor: extractorLabel,
        };
        work = logTrace(work, trace);

        await persistState(chatId, work);
        return { added, updated, drained: r, parseFailures: 0, entriesSkipped: extracted.skipped };
    });
}
