/**
 * Persona rebuild orchestrator. The ONE public entry point for Phase 7.
 *
 * Pipeline:
 *   1. Snapshot episodic entries for the target subject (read-only, no lock).
 *   2. chunkEntries → Leaf[].
 *   3. For each depth 0..MAX_DEPTH:
 *      a. Build k-NN graph (adaptive k).
 *      b. Leiden cluster (adaptive γ).
 *      c. Stop if <2 clusters or too few leaves for another layer.
 *      d. Summarize each cluster via LLM; collect summaries as next-layer leaves.
 *   4. Flatten all non-layer-0 summaries into replacement Persona entries.
 *   5. atomicReplacePersona (single write lock).
 *
 * The snapshot-then-swap pattern means consolidation can run concurrently with
 * persona rebuild — they only collide on the brief atomic-swap write lock at
 * the very end. Phase 8's integration layer should, however, prefer to
 * cancel any in-flight rebuild before allowing chat switch.
 *
 * AbortSignal is threaded through every async stage. On abort: throws
 * AbortError, zero state mutation, temp collections purged.
 *
 * @module consolidation/personaRebuild
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.4
 */

import { loadState } from '../core/state.js';
import { PERSONA_REBUILD } from '../core/constants.js';
import { chunkEntries } from './raptor/chunking.js';
import { buildKnnGraph } from './raptor/knn.js';
import { leidenCluster, gammaForDepth } from './raptor/leiden.js';
import { summarizeCluster } from './raptor/summarize.js';
import { atomicReplacePersona } from './raptor/atomic.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('personaRebuild');

const { MAX_DEPTH, MIN_CLUSTER_SIZE } = PERSONA_REBUILD;

/**
 * @typedef {import('./raptor/chunking.js').Leaf} Leaf
 */

/**
 * @typedef {object} RebuildOptions
 * @property {string} profileId                - ST connection profile for extractor LLM.
 * @property {string} extractorLabel           - e.g. "gemma-4-31b@persona-rebuild-v1"
 * @property {AbortSignal} [signal]
 * @property {(progress: { stage: string, depth?: number, clusters?: number }) => void} [onProgress]
 * @property {Date} [now]
 */

/**
 * @typedef {object} RebuildReport
 * @property {number} episodicCount
 * @property {number} layers
 * @property {number} replacedCount
 * @property {number} newCount
 * @property {number} duration                 - Wall-clock ms.
 */

/**
 * Run the full persona rebuild pipeline for a subject. Returns a report.
 *
 * @param {string} chatId
 * @param {string} subject
 * @param {RebuildOptions} opts
 * @returns {Promise<RebuildReport>}
 */
export async function rebuildPersona(chatId, subject, opts) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('rebuildPersona: chatId required');
    }
    if (typeof subject !== 'string' || subject.length === 0) {
        throw new Error('rebuildPersona: subject required');
    }
    if (!opts || typeof opts !== 'object') {
        throw new Error('rebuildPersona: options required');
    }
    const { profileId, extractorLabel, signal, onProgress, now } = opts;
    if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('rebuildPersona: opts.profileId required');
    }
    if (typeof extractorLabel !== 'string' || extractorLabel.length === 0) {
        throw new Error('rebuildPersona: opts.extractorLabel required');
    }

    const throwIfAborted = () => {
        if (signal?.aborted) {
            const err = new Error('rebuildPersona: aborted');
            err.name = 'AbortError';
            throw err;
        }
    };

    const report = (/** @type {string} */ stage, /** @type {any} */ extra) => {
        try { onProgress?.({ stage, ...(extra ?? {}) }); } catch { /* swallow */ }
    };

    const startTime = Date.now();
    throwIfAborted();
    report('snapshot');

    // Snapshot: read-only. If Episodic changes concurrently, the final atomic
    // swap still persists our new Persona entries — the snapshot just means our
    // summaries may slightly lag a mid-rebuild consolidation. Acceptable.
    const state = await loadState(chatId);
    const episodic = Object.values(state.entries).filter(
        e => e.scope === 'episodic' && e.subject === subject,
    );
    if (episodic.length === 0) {
        throw new Error(`rebuildPersona: no episodic entries for subject "${subject}"`);
    }

    report('chunk', { count: episodic.length });
    let currentLeaves = chunkEntries(episodic);

    /** @type {Array<{ depth: number, text: string, sourceEntryIds: string[] }>} */
    const collectedSummaries = [];

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        throwIfAborted();
        if (currentLeaves.length < MIN_CLUSTER_SIZE * 2) {
            log.info(`stop at depth ${depth}: too few leaves (${currentLeaves.length})`);
            break;
        }

        // Build k-NN graph for this layer.
        const collectionId = `starmem:${chatId}:${subject}:persona-rebuild:${depth}:${Date.now()}`;
        report('knn', { depth, leaves: currentLeaves.length });
        const graph = await buildKnnGraph(currentLeaves, depth, collectionId, signal);
        throwIfAborted();

        // Cluster.
        const gamma = gammaForDepth(depth);
        report('cluster', { depth, gamma });
        const { clusters, communityCount } = leidenCluster(graph, gamma, { seed: 1, signal });
        throwIfAborted();

        if (communityCount < 2) {
            log.info(`stop at depth ${depth}: only ${communityCount} community`);
            break;
        }

        // Group leaves by cluster.
        /** @type {Map<number, Leaf[]>} */
        const byCluster = new Map();
        for (const leaf of currentLeaves) {
            const c = clusters.get(leaf.id);
            if (c === undefined) continue;
            const bucket = byCluster.get(c) ?? [];
            bucket.push(leaf);
            byCluster.set(c, bucket);
        }

        // Summarize each cluster.
        /** @type {Leaf[]} */
        const nextLayerLeaves = [];
        let clusterIdx = 0;
        for (const [, members] of byCluster) {
            throwIfAborted();
            report('summarize', { depth, cluster: clusterIdx });
            const { text, sourceLeafIds } = await summarizeCluster(members, {
                profileId, subject, depth, signal,
            });
            collectedSummaries.push({ depth: depth + 1, text, sourceEntryIds: sourceLeafIds });
            nextLayerLeaves.push({
                id: `leaf_depth${depth + 1}_${clusterIdx}`,
                sourceEntryIds: sourceLeafIds,
                text,
                subject,
            });
            clusterIdx++;
        }

        currentLeaves = nextLayerLeaves;
    }

    // At this point, `currentLeaves` holds the deepest layer's summaries
    // (potentially multiple if we stopped at MAX_DEPTH without collapsing to one).
    // We additionally want the final root-level summary if we haven't stopped
    // at a single cluster. If currentLeaves.length > 1 and we exited by
    // MAX_DEPTH rather than communityCount < 2, merge the final layer into
    // one root summary.
    if (currentLeaves.length > 1 && collectedSummaries.length > 0) {
        throwIfAborted();
        report('summarize-root');
        const { text, sourceLeafIds } = await summarizeCluster(currentLeaves, {
            profileId, subject, depth: MAX_DEPTH, signal,
        });
        collectedSummaries.push({ depth: MAX_DEPTH + 1, text, sourceEntryIds: sourceLeafIds });
    } else if (collectedSummaries.length === 0) {
        // We never clustered (e.g. only 1 or 2 episodic entries). Produce a
        // single Persona summary from the leaves directly.
        throwIfAborted();
        report('summarize-root-direct');
        const { text, sourceLeafIds } = await summarizeCluster(currentLeaves, {
            profileId, subject, depth: 0, signal,
        });
        collectedSummaries.push({ depth: 1, text, sourceEntryIds: sourceLeafIds });
    }

    // Build replacement entries. Source-message indices are carried through
    // from the original episodic entries via sourceEntryIds → lookup in the
    // snapshot.
    const episodicById = new Map(episodic.map(e => [e.id, e]));
    /** @type {import('./raptor/atomic.js').PersonaReplacement[]} */
    const replacements = collectedSummaries.map(s => {
        /** @type {Set<number>} */
        const msgs = new Set();
        for (const eid of s.sourceEntryIds) {
            const e = episodicById.get(eid);
            if (!e) continue;
            for (const m of e.provenance.sourceMessages) msgs.add(m);
        }
        return { text: s.text, sourceMessages: [...msgs].sort((a, b) => a - b) };
    });

    report('atomic-swap', { count: replacements.length });
    throwIfAborted();
    const { deletedCount, addedCount } = await atomicReplacePersona({
        chatId, subject, extractorLabel, replacements, now, signal,
    });

    return {
        episodicCount: episodic.length,
        layers: collectedSummaries.length,
        replacedCount: deletedCount,
        newCount: addedCount,
        duration: Date.now() - startTime,
    };
}
