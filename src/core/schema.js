/**
 * STARmem schema—JSDoc types for the persisted state tree.
 * Runtime helpers are limited to frozen enums and tier-union constants.
 * Validators live alongside the factories that produce each shape
 * (see `src/memory/entry.js` for `isValidEntry`; see `createEmptyState`
 * in this module for the top-level state).
 *
 * @module core/schema
 * @see docs/specs/2026-04-20-starmem-v2-design.md §3
 */

import { SCOPES, EDGE_TYPES, MATURITY_TIERS } from './constants.js';

/**
 * @typedef {'working' | 'episodic' | 'persona'} Scope
 */

/**
 * @typedef {'draft' | 'validated' | 'core'} Maturity
 */

/**
 * @typedef {'mentions' | 'supports' | 'same_topic' | 'temporal_next' | 'contradicts'} EdgeType
 */

/**
 * @typedef {object} Relation
 * @property {EdgeType} type
 * @property {string} target  - Entry id this relation points at.
 */

/**
 * @typedef {object} Lifecycle
 * @property {number} importance    - [0, 100]; see spec §7.
 * @property {Maturity} maturity
 * @property {string} createdAt     - ISO 8601 timestamp.
 * @property {string} updatedAt     - ISO 8601 timestamp.
 * @property {number} accessCount
 * @property {number} updateCount
 */

/**
 * @typedef {object} Provenance
 * @property {number[]} sourceMessages  - Indices into the ST chat array.
 * @property {string} extractor         - e.g. "gemma-4-31b@consolidation-v1".
 */

/**
 * @typedef {object} Entry
 * @property {string} id
 * @property {Scope} scope
 * @property {string} content
 * @property {string | null} subject
 * @property {string[]} tags
 * @property {Relation[]} relations
 * @property {Lifecycle} lifecycle
 * @property {Provenance} provenance
 */

/**
 * @typedef {object} Edge
 * @property {string} from
 * @property {string} to
 * @property {EdgeType} type
 * @property {number} weight
 */

/**
 * @typedef {object} Runtime
 * @property {string | null} lastConsolidation   - ISO timestamp or null.
 * @property {boolean} pendingPersonaRebuild
 * @property {object[]} traces                    - Ring buffer, cap TRACE_BUFFER_CAP.
 */

/**
 * @typedef {object} TierCaches
 * @property {Object<string, string[]>} exact
 * @property {Object<string, string[]>} fuzzy
 */

/**
 * @typedef {object} State
 * @property {Object<string, Entry>} entries
 * @property {string[]} workingBuffer
 * @property {{ edges: Edge[] }} graph
 * @property {TierCaches} tierCaches
 * @property {Runtime} runtime
 */

/** Union of all valid edge types (produced + reserved). Spec §4. */
export const ALL_EDGE_TYPES = Object.freeze([
    ...EDGE_TYPES.PRODUCED,
    ...EDGE_TYPES.RESERVED,
]);

/** Return true iff `s` is a valid scope. */
export function isScope(s) {
    return typeof s === 'string' && SCOPES.includes(s);
}

/** Return true iff `m` is a valid maturity tier. */
export function isMaturity(m) {
    return typeof m === 'string' && MATURITY_TIERS.includes(m);
}

/** Return true iff `t` is a valid edge type (produced or reserved). */
export function isEdgeType(t) {
    return typeof t === 'string' && ALL_EDGE_TYPES.includes(t);
}

/**
 * Build a fresh, empty State. Every field is initialized to its zero
 * value per spec §3.2. No persistence side effects.
 *
 * @returns {State}
 */
export function createEmptyState() {
    return {
        entries: {},
        workingBuffer: [],
        graph: { edges: [] },
        tierCaches: { exact: {}, fuzzy: {} },
        runtime: {
            lastConsolidation: null,
            pendingPersonaRebuild: false,
            traces: [],
        },
    };
}
