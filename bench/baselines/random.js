/**
 * Random baseline retriever.
 *
 * Deterministic shuffle via Mulberry32 PRNG seeded by SHA-256 hash of
 * the query string. Returns top-K in shuffled order. Measures the floor
 * — how much any real retriever must beat to earn its keep.
 *
 * @module bench/baselines/random
 * @see docs/plans/phase-9-benchmarking.md §Task 8
 */

import { createHash } from 'node:crypto';
import { buildTrace, logTrace } from '../../src/retrieval/trace.js';

/**
 * Mulberry32 PRNG. Deterministic, fast, decent quality for shuffling.
 *
 * @param {number} seed - uint32
 * @returns {() => number} - returns [0, 1)
 */
function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Derive a uint32 seed from a string via SHA-256 first 4 bytes.
 *
 * @param {string} s
 * @returns {number}
 */
function hashSeed(s) {
    const buf = createHash('sha256').update(s).digest();
    return buf.readUInt32BE(0);
}

/**
 * Fisher-Yates shuffle using a PRNG.
 *
 * @template T
 * @param {T[]} arr
 * @param {() => number} rng
 * @returns {T[]}
 */
function shuffle(arr, rng) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * @param {import('../../src/core/schema.js').State} state
 * @param {string} queryStr
 * @param {{ now?: Date, k?: number }} [opts]
 * @returns {import('../../src/retrieval/ladder.js').RetrieveResult}
 */
export function random(state, queryStr, opts = {}) {
    const { now = new Date(), k = 5 } = opts;
    const entries = Object.values(state.entries);

    if (entries.length === 0) {
        const trace = buildTrace({
            timestamp: now.toISOString(),
            query: queryStr,
            classifier: 'factual',
            tierResolved: 'random',
            perTier: { random: [] },
            finalRanking: [],
            scorerId: 'random',
        });
        const nextState = logTrace(state, trace);
        return { entries: [], tierResolved: 'random', trace, state: nextState };
    }

    const seed = hashSeed(queryStr);
    const rng = mulberry32(seed);
    const ranked = shuffle(entries, rng).slice(0, k);

    const trace = buildTrace({
        timestamp: now.toISOString(),
        query: queryStr,
        classifier: 'factual',
        tierResolved: 'random',
        perTier: { random: ranked.map(e => ({ id: e.id })) },
        finalRanking: ranked.map(e => e.id),
        scorerId: 'random',
    });
    const nextState = logTrace(state, trace);

    return {
        entries: ranked,
        tierResolved: 'random',
        trace,
        state: nextState,
    };
}
