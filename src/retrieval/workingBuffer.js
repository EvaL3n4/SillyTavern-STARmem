/**
 * Working-buffer prepend. Spec §5: "Working buffer is prepended to every
 * result unconditionally—it is not a tier."
 *
 * Working entries are assigned sentinel score=Infinity to guarantee they
 * outrank any scored tier output, without letting lifecycle factors (decay,
 * maturity) affect their ranking.
 *
 * @module retrieval/workingBuffer
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

/**
 * @typedef {{
 *   entry: import('../core/schema.js').Entry,
 *   bm25: number,
 *   score: number
 * }} ScoredEntry
 */

/**
 * Prepend working-buffer entries to a scored result list. Dedupes against
 * `results` by id, keeping the working-buffer copy (freshest view).
 *
 * @param {ScoredEntry[]} results
 * @param {import('../core/schema.js').Entry[]} workingEntries
 * @param {Date} _now - Reserved for future factor-awareness; currently unused.
 * @returns {ScoredEntry[]}
 */
export function prependWorking(results, workingEntries, _now) {
    if (!Array.isArray(results)) {
        throw new Error('prependWorking: results must be an array');
    }
    if (!Array.isArray(workingEntries)) {
        throw new Error('prependWorking: workingEntries must be an array');
    }

    const workingIds = new Set(workingEntries.map(e => e.id));
    const prepended = workingEntries.map(entry => ({
        entry,
        bm25: 0,
        score: Infinity,
    }));
    const filteredResults = results.filter(r => !workingIds.has(r.entry.id));
    return [...prepended, ...filteredResults];
}
