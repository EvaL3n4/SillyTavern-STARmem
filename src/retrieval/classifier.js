/**
 * Rule-based query classifier. Returns 'factual' | 'relational' | 'temporal'.
 * No LLM—spec §2 principle 1 (deterministic retrieval, always).
 *
 * Priority: temporal > relational > factual. "When did Alice meet Bob?"
 * routes to temporal because spec §5.1's edge-weight table gives
 * temporal_next=0.9 on temporal queries vs only 0.4 on relational.
 *
 * @module retrieval/classifier
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

const TEMPORAL_PATTERNS = [
    /\bwhen\b/i,
    /\b(before|after|during|recently|yesterday|today)\b/i,
    /\blast\s+(week|month|year|time)\b/i,
    /\b(19|20|21)\d{2}\b/,
    /\bago\b/i,
];

const RELATIONAL_PATTERNS = [
    /\bwho\b/i,
    /\bwith\s+whom\b/i,
    /\btogether\b/i,
    /\brelated\b/i,
    /\bconnection\b/i,
    /\bbetween\s+\w+\s+and\s+\w+/i,
    /\brelate(s|d)?\b/i,
    // Two capitalized tokens joined by and/&/,
    /\b[A-Z][a-z]+\s+(and|&|,)\s+[A-Z][a-z]+/,
];

/**
 * Classify a query into one of three intents. Temporal wins over relational
 * wins over factual (priority order matters for §5 edge-weight routing).
 *
 * @param {string} query
 * @returns {'factual' | 'relational' | 'temporal'}
 */
export function classify(query) {
    if (typeof query !== 'string') {
        throw new Error(`classify: query must be a string, got ${typeof query}`);
    }
    if (query.trim().length === 0) return 'factual';

    for (const re of TEMPORAL_PATTERNS) {
        if (re.test(query)) return 'temporal';
    }
    for (const re of RELATIONAL_PATTERNS) {
        if (re.test(query)) return 'relational';
    }
    return 'factual';
}
