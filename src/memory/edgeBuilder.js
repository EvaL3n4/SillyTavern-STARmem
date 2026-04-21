/**
 * Edge builder. Pure function from (entry, allEntries, state) to the
 * newEdges / evicted pair. Phase 6's consolidate() applies both inside the
 * write lock.
 *
 * Sources of edges:
 *  1. Explicit @relations in extracted entries (weight = EXPLICIT_RELATION_WEIGHT)
 *  2. Entity co-occurrence via capitalized-noun match (weight = COOCCURRENCE_WEIGHT,
 *     type = 'mentions')
 *
 * contradicts edges are reserved in schema but never emitted here — spec §11.
 *
 * @module memory/edgeBuilder
 * @see docs/specs/2026-04-20-starmem-v2-design.md §4, §6.3, §11, §12.2
 */

import { RETRIEVAL } from '../core/constants.js';

const ENTITY_RE = /\b[A-Z][a-z]{2,}\b/g;

const STOP_WORDS = new Set(['A', 'I', 'The', 'It', 'Is', 'In', 'Of', 'Or', 'On', 'At', 'To', 'An', 'As', 'Be', 'By', 'Do', 'Go', 'He', 'Me', 'My', 'No', 'So', 'Up', 'Us', 'We']);

/**
 * Extract capitalized-noun entities from text. Case-sensitive; deduplicated.
 * Filters out common sentence-start stop words (the/a/i/etc) by requiring
 * ≥3 lowercase chars and removing known stop words.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractEntities(text) {
    if (typeof text !== 'string') return [];
    const matches = text.match(ENTITY_RE);
    if (!matches) return [];
    return Array.from(new Set(matches.filter(m => !STOP_WORDS.has(m))));
}

/**
 * @typedef {import('../core/schema.js').Edge} Edge
 * @typedef {import('../core/schema.js').Entry} Entry
 * @typedef {import('../core/schema.js').State} State
 */

/**
 * Build edges for `entry` against the corpus. Pure; returns the edges to
 * add and any existing edges from this source that must be evicted to stay
 * under EDGE_CAP_PER_ENTRY.
 *
 * @param {Entry} entry
 * @param {Entry[]} allEntries
 * @param {State} state
 * @returns {{ newEdges: Edge[], evicted: Edge[] }}
 */
export function buildEdges(entry, allEntries, state) {
    /** @type {Edge[]} */
    const candidates = [];

    // 1. Explicit relations
    for (const rel of entry.relations) {
        candidates.push({
            from: entry.id,
            to: rel.target,
            type: rel.type,
            weight: RETRIEVAL.EXPLICIT_RELATION_WEIGHT,
        });
    }

    // 2. Co-occurrence
    const myEntities = new Set(extractEntities(entry.content));
    if (myEntities.size > 0) {
        for (const other of allEntries) {
            if (other.id === entry.id) continue;
            if (other.scope === 'working') continue;
            const otherEntities = extractEntities(other.content);
            let overlap = false;
            for (const e of otherEntities) {
                if (myEntities.has(e)) { overlap = true; break; }
            }
            if (overlap) {
                candidates.push({
                    from: entry.id,
                    to: other.id,
                    type: 'mentions',
                    weight: RETRIEVAL.COOCCURRENCE_WEIGHT,
                });
            }
        }
    }

    // 3. Dedup candidates by (from, to, type); keep highest weight (explicit wins)
    /** @type {Map<string, Edge>} */
    const dedup = new Map();
    for (const c of candidates) {
        const key = `${c.from}\u0000${c.to}\u0000${c.type}`;
        const prev = dedup.get(key);
        if (!prev || c.weight > prev.weight) dedup.set(key, c);
    }
    const merged = Array.from(dedup.values());

    // 4. Cap enforcement on combined (existing + new) edges from this source
    const existingFromEntry = state.graph.edges.filter(e => e.from === entry.id);
    const existingKeys = new Set(
        existingFromEntry.map(e => `${e.from}\u0000${e.to}\u0000${e.type}`),
    );
    const newEdges = merged.filter(
        e => !existingKeys.has(`${e.from}\u0000${e.to}\u0000${e.type}`),
    );

    // Stable sort by weight desc; at equal weight, NEW edges win ties (fresher info).
    const tagged = [
        ...existingFromEntry.map(e => ({ edge: e, isExisting: true })),
        ...newEdges.map(e => ({ edge: e, isExisting: false })),
    ];
    tagged.sort((a, b) => {
        if (b.edge.weight !== a.edge.weight) return b.edge.weight - a.edge.weight;
        return (a.isExisting ? 1 : 0) - (b.isExisting ? 1 : 0);
    });
    const keep = tagged.slice(0, RETRIEVAL.EDGE_CAP_PER_ENTRY);

    const keptKeys = new Set(
        keep.map(t => `${t.edge.from}\u0000${t.edge.to}\u0000${t.edge.type}`),
    );
    const evicted = existingFromEntry.filter(
        e => !keptKeys.has(`${e.from}\u0000${e.to}\u0000${e.type}`),
    );
    const finalNewEdges = newEdges.filter(
        e => keptKeys.has(`${e.from}\u0000${e.to}\u0000${e.type}`),
    );
    // Edges in the discarded-tail that are new (not existing) simply aren't returned
    // in newEdges — they're dropped rather than evicted.

    return { newEdges: finalNewEdges, evicted };
}
