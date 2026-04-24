/**
 * Entry factory and validator. The one place entries are constructed;
 * consolidation calls `createEntry` and nothing else builds entries ad-hoc.
 *
 * @module memory/entry
 * @see docs/specs/2026-04-20-starmem-v2-design.md §3.1
 */

import { sha256Hex } from '../vendor/sha256.js';
import { isScope, isMaturity, isEdgeType } from '../core/schema.js';

/** Scope → id prefix. */
const SCOPE_PREFIX = Object.freeze({
    working: 'wk',
    episodic: 'ep',
    persona: 'ps',
});

/**
 * Derive a 12-hex-char suffix from a content seed. Deterministic: same seed
 * always produces the same suffix, so replayed extractions on identical
 * inputs yield identical entry ids. 12 hex chars = 48 bits, ~281T values —
 * collision-safe for any realistic corpus size.
 *
 * @param {string} seed
 * @returns {string}
 */
function contentSuffix(seed) {
    return sha256Hex(seed).slice(0, 12);
}

/**
 * Generate an entry id of the form `<prefix>_<iso>_<suffix>`, e.g.
 * `ep_2026-04-20T14:12:33_a3f124cde091`. ISO timestamp is trimmed to
 * second precision; suffix is sha256(seed).slice(0,12).
 *
 * @param {import('../core/schema.js').Scope} scope
 * @param {Date} now
 * @param {string} seed - Content-derived stable string, see contentSuffix.
 * @returns {string}
 */
export function generateEntryId(scope, now, seed) {
    if (!isScope(scope)) {
        throw new Error(`generateEntryId: invalid scope ${String(scope)}`);
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('generateEntryId: now must be a valid Date');
    }
    if (typeof seed !== 'string' || seed.length === 0) {
        throw new Error('generateEntryId: seed required (non-empty string)');
    }
    const iso = now.toISOString().replace(/\.\d+Z$/, '');
    return `${SCOPE_PREFIX[scope]}_${iso}_${contentSuffix(seed)}`;
}

/**
 * Build a fresh entry from caller-supplied fields. Defaults lifecycle to
 * spec §7 baseline (importance=50, maturity='draft', counts=0).
 *
 * @param {object} fields
 * @param {import('../core/schema.js').Scope} fields.scope
 * @param {string} fields.content
 * @param {string | null} fields.subject
 * @param {string[]} fields.tags
 * @param {import('../core/schema.js').Relation[]} [fields.relations]
 * @param {import('../core/schema.js').Provenance} fields.provenance
 * @param {Date} [fields.now] - Inject a clock for deterministic tests.
 * @returns {import('../core/schema.js').Entry}
 */
export function createEntry(fields) {
    if (!fields || typeof fields !== 'object') {
        throw new Error('createEntry: fields object required');
    }
    const { scope, content, subject, tags, relations = [], provenance, now } = fields;
    if (!isScope(scope)) {
        throw new Error(`createEntry: invalid scope ${String(scope)}`);
    }
    if (typeof content !== 'string' || content.length === 0) {
        throw new Error('createEntry: content must be a non-empty string');
    }
    if (subject !== null && typeof subject !== 'string') {
        throw new Error('createEntry: subject must be string or null');
    }
    if (!Array.isArray(tags)) {
        throw new Error('createEntry: tags must be an array');
    }
    if (!Array.isArray(relations)) {
        throw new Error('createEntry: relations must be an array');
    }
    if (!provenance || typeof provenance !== 'object'
        || !Array.isArray(provenance.sourceMessages)
        || typeof provenance.extractor !== 'string') {
        throw new Error('createEntry: provenance must be { sourceMessages: number[], extractor: string }');
    }

    const when = now ?? new Date();
    const iso = when.toISOString();

    const seed = [
        scope,
        content,
        subject ?? '',
        [...tags].sort().join(','),
        provenance.sourceMessages.join(','),
        provenance.extractor,
    ].join('|');

    return {
        id: generateEntryId(scope, when, seed),
        scope,
        content,
        subject,
        tags: [...tags],
        relations: relations.map(r => ({ type: r.type, target: r.target })),
        lifecycle: {
            importance: 50,
            maturity: 'draft',
            createdAt: iso,
            updatedAt: iso,
            accessCount: 0,
            updateCount: 0,
        },
        provenance: {
            sourceMessages: [...provenance.sourceMessages],
            extractor: provenance.extractor,
        },
    };
}

/**
 * Total validator. Returns true iff `x` has the full shape required by
 * spec §3.1. Used by persist/load to reject malformed state and by later
 * phases to guard index builds.
 *
 * @param {unknown} x
 * @returns {boolean}
 */
export function isValidEntry(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const e = /** @type {Record<string, unknown>} */ (x);

    if (typeof e.id !== 'string' || e.id.length === 0) return false;
    if (!isScope(e.scope)) return false;
    if (typeof e.content !== 'string' || e.content.length === 0) return false;
    if (e.subject !== null && typeof e.subject !== 'string') return false;
    if (!Array.isArray(e.tags) || !e.tags.every(t => typeof t === 'string')) return false;

    if (!Array.isArray(e.relations)) return false;
    for (const r of e.relations) {
        if (!r || typeof r !== 'object') return false;
        const rel = /** @type {Record<string, unknown>} */ (r);
        if (!isEdgeType(rel.type)) return false;
        if (typeof rel.target !== 'string' || rel.target.length === 0) return false;
    }

    const l = /** @type {Record<string, unknown>} */ (e.lifecycle);
    if (!l || typeof l !== 'object') return false;
    if (typeof l.importance !== 'number' || l.importance < 0 || l.importance > 100) return false;
    if (!isMaturity(l.maturity)) return false;
    if (typeof l.createdAt !== 'string' || typeof l.updatedAt !== 'string') return false;
    if (typeof l.accessCount !== 'number' || l.accessCount < 0) return false;
    if (typeof l.updateCount !== 'number' || l.updateCount < 0) return false;

    const p = /** @type {Record<string, unknown>} */ (e.provenance);
    if (!p || typeof p !== 'object') return false;
    if (!Array.isArray(p.sourceMessages) || !p.sourceMessages.every(n => typeof n === 'number')) return false;
    if (typeof p.extractor !== 'string') return false;

    return true;
}
