/**
 * Memory barrel. Single import surface for the graph infrastructure and
 * edge builder. Phase 6's consolidate() imports from here.
 *
 * @module memory
 * @see docs/specs/2026-04-20-starmem-v2-design.md §4
 */

export { createEntry, isValidEntry, generateEntryId } from './entry.js';
export {
    addEdge,
    removeEdge,
    listEdges,
    buildAdjacency,
    neighborsOf,
} from './graph.js';
export { buildEdges, extractEntities } from './edgeBuilder.js';
