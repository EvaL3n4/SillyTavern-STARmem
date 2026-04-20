/**
 * Retrieval ladder orchestrator. Composes classifier + Tier 0/1/2/3/Floor
 * with working-buffer prepend, access-event bumps on returned entries, and
 * a single trace per call.
 *
 * @module retrieval/ladder
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

import { RETRIEVAL } from '../core/constants.js';
import { applyAccessEvent } from '../lifecycle/index.js';
import { classify } from './classifier.js';
import { getScorerId } from './scorer.js';
import { tier0, recordTier0 } from './tier0-exact.js';
import { tier1, recordTier1 } from './tier1-fuzzy.js';
import { tier2 } from './tier2-bm25.js';
import { tier3 } from './tier3-graph.js';
import { floor } from './floor.js';
import { logTrace, buildTrace } from './trace.js';
import { prependWorking } from './workingBuffer.js';

/**
 * @typedef {import('../core/schema.js').State} State
 * @typedef {import('../core/schema.js').Entry} Entry
 * @typedef {import('./trace.js').Trace} Trace
 * @typedef {import('./tier2-bm25.js').ScoredEntry} ScoredEntry
 */

/**
 * @typedef {{
 *   entries: Entry[],
 *   tierResolved: 0 | 1 | 2 | 3 | 'floor',
 *   trace: Trace,
 *   state: State,
 * }} RetrieveResult
 */

/**
 * Dereference state.workingBuffer ids to Entry[], skipping missing ids.
 * @param {State} state
 * @returns {Entry[]}
 */
function workingEntriesOf(state) {
    const out = [];
    for (const id of state.workingBuffer) {
        const e = state.entries[id];
        if (e) out.push(e);
    }
    return out;
}

/**
 * Wrap plain entries as ScoredEntry with bm25=0, score=0. Used when a tier
 * returns ids only (Tier 0, Tier 1) and we need the uniform prepend shape.
 * @param {Entry[]} entries
 * @returns {ScoredEntry[]}
 */
function wrapZero(entries) {
    return entries.map(entry => ({ entry, bm25: 0, score: 0 }));
}

/**
 * Apply one access event per returned entry. Pure—returns new state and the
 * updated entry objects. Missing ids pass through untouched (defensive).
 * @param {State} state
 * @param {Entry[]} entries
 * @returns {{ state: State, entries: Entry[] }}
 */
function applyAccessEventsToReturned(state, entries) {
    const nextEntries = { ...state.entries };
    const updated = [];
    for (const e of entries) {
        const existing = nextEntries[e.id];
        if (!existing) {
            updated.push(e);
            continue;
        }
        const newLifecycle = applyAccessEvent(existing.lifecycle);
        const newEntry = { ...existing, lifecycle: newLifecycle };
        nextEntries[e.id] = newEntry;
        updated.push(newEntry);
    }
    return { state: { ...state, entries: nextEntries }, entries: updated };
}

/**
 * Run the Floor branch of the ladder. Factored out so Tier 3 can fall through
 * to Floor when graph expansion yields nothing.
 *
 * @param {State} state
 * @param {string} queryStr
 * @param {'factual'|'relational'|'temporal'} classifier
 * @param {string} scorerId
 * @param {Entry[]} working
 * @param {Date} now
 * @param {number} k
 * @param {{ perTier2?: { id: string, bm25: number, score: number }[] }} [tracePrefix]
 * @returns {RetrieveResult}
 */
function runFloorBranch(state, queryStr, classifier, scorerId, working, now, k, tracePrefix = {}) {
    const floorResults = floor(state, { now, k });
    let s1 = state;
    if (floorResults.length > 0) {
        const final = applyAccessEventsToReturned(s1, floorResults.map(r => r.entry));
        s1 = final.state;
    }
    const prepended = prependWorking(floorResults, working, now);
    /** @type {Record<string, unknown>} */
    const perTier = {};
    if (tracePrefix.perTier2) perTier['2'] = tracePrefix.perTier2;
    const trace = buildTrace({
        timestamp: now.toISOString(),
        query: queryStr,
        classifier,
        tierResolved: 'floor',
        perTier,
        finalRanking: prepended.map(r => r.entry.id),
        scorerId,
    });
    const nextState = logTrace(s1, trace);
    return {
        entries: prepended.map(r => r.entry),
        tierResolved: 'floor',
        trace,
        state: nextState,
    };
}

/**
 * Run the full retrieval ladder. Single entry point — Phase 8's
 * STARmemInterceptor calls this on every user turn.
 *
 * @param {State} state
 * @param {string} queryStr
 * @param {{ now?: Date, k?: number }} [opts]
 * @returns {RetrieveResult}
 */
export function retrieve(state, queryStr, opts = {}) {
    const { now = new Date(), k = 5 } = opts;
    const classifier = classify(queryStr);
    const scorerId = getScorerId();
    const working = workingEntriesOf(state);
    const cap = k + working.length;

    // --- Tier 0 ---
    const t0 = tier0(state, queryStr);
    if (t0.hit) {
        const final = applyAccessEventsToReturned(state, t0.entries);
        const prepended = prependWorking(wrapZero(final.entries), working, now);
        const trace = buildTrace({
            timestamp: now.toISOString(),
            query: queryStr,
            classifier,
            tierResolved: 0,
            perTier: { '0': t0.entries.map(e => ({ id: e.id })) },
            finalRanking: prepended.map(r => r.entry.id),
            scorerId,
        });
        const nextState = logTrace(final.state, trace);
        return {
            entries: prepended.map(r => r.entry).slice(0, cap),
            tierResolved: 0,
            trace,
            state: nextState,
        };
    }

    // --- Tier 1 ---
    const t1 = tier1(state, queryStr);
    if (t1.hit) {
        const cached = recordTier0(state, queryStr, t1.entries);
        const final = applyAccessEventsToReturned(cached, t1.entries);
        const prepended = prependWorking(wrapZero(final.entries), working, now);
        const trace = buildTrace({
            timestamp: now.toISOString(),
            query: queryStr,
            classifier,
            tierResolved: 1,
            perTier: { '1': t1.entries.map(e => ({ id: e.id })) },
            finalRanking: prepended.map(r => r.entry.id),
            scorerId,
        });
        const nextState = logTrace(final.state, trace);
        return {
            entries: prepended.map(r => r.entry).slice(0, cap),
            tierResolved: 1,
            trace,
            state: nextState,
        };
    }

    // --- Tier 2 ---
    const t2 = tier2(state, queryStr, { now, intent: classifier, k: 10 });
    if (t2.hit) {
        const topK = t2.scored.slice(0, k);
        const entriesOnly = topK.map(r => r.entry);
        let cached = recordTier0(state, queryStr, entriesOnly);
        cached = recordTier1(cached, queryStr, entriesOnly);
        const final = applyAccessEventsToReturned(cached, entriesOnly);
        const prepended = prependWorking(topK, working, now);
        const trace = buildTrace({
            timestamp: now.toISOString(),
            query: queryStr,
            classifier,
            tierResolved: 2,
            perTier: {
                '2': topK.map(r => ({ id: r.entry.id, bm25: r.bm25, score: r.score })),
                '3': null,
            },
            finalRanking: prepended.map(r => r.entry.id),
            scorerId,
        });
        const nextState = logTrace(final.state, trace);
        return {
            entries: prepended.map(r => r.entry).slice(0, cap),
            tierResolved: 2,
            trace,
            state: nextState,
        };
    }

    // --- Tier 3: intent-routed graph expansion ---
    if (t2.scored.length > 0) {
        const seeds = t2.scored.slice(0, RETRIEVAL.TIER3_SEEDS_K).map(r => r.entry);
        const t3Scored = tier3(state, seeds, queryStr, classifier, { now, k });

        // Tier 3 produced nothing — fall through to Floor with Tier 2 prefix in trace
        if (t3Scored.length === 0) {
            return runFloorBranch(state, queryStr, classifier, scorerId, working, now, k, {
                perTier2: t2.scored.map(r => ({ id: r.entry.id, bm25: r.bm25, score: r.score })),
            });
        }

        const topK = t3Scored;
        const entriesOnly = topK.map(r => r.entry);
        let cached = recordTier0(state, queryStr, entriesOnly);
        cached = recordTier1(cached, queryStr, entriesOnly);
        const final = applyAccessEventsToReturned(cached, entriesOnly);
        const prepended = prependWorking(topK, working, now);
        const trace = buildTrace({
            timestamp: now.toISOString(),
            query: queryStr,
            classifier,
            tierResolved: 3,
            perTier: {
                '2': t2.scored.map(r => ({ id: r.entry.id, bm25: r.bm25, score: r.score })),
                '3': topK.map(r => ({ id: r.entry.id, bm25: r.bm25, score: r.score })),
            },
            finalRanking: prepended.map(r => r.entry.id),
            scorerId,
        });
        const nextState = logTrace(final.state, trace);
        return {
            entries: prepended.map(r => r.entry).slice(0, cap),
            tierResolved: 3,
            trace,
            state: nextState,
        };
    }

    // --- Floor ---
    return runFloorBranch(state, queryStr, classifier, scorerId, working, now, k);
}
