/**
 * Shared sweep driver for STARmem benchmark parameter sweeps.
 *
 * Reused by Tasks 4-7 (tau, graph, dedup, persona sweeps).
 *
 * @module bench/sweeps/_driver
 * @see docs/plans/phase-9-benchmarking.md §Task 4
 */

import { runHarness } from '../runner.js';

/**
 * Map primary-metric names to accessors on MetricsResult.
 *
 * @type {Record<string, (m: import('../metrics/retrieval.js').MetricsResult) => number>}
 */
export const METRIC_ACCESSORS = {
    recallAt5:    m => m.recallAtK[5],
    recallAt10:   m => m.recallAtK[10],
    precisionAt3: m => m.precisionAtK[3],
    precisionAt5: m => m.precisionAtK[5],
    mrr:          m => m.mrr,
};

/** Default elbow-detection ratio. */
const ELBOW_RATIO = 0.1;

/**
 * @typedef {import('../loaders/locomo.js').CorpusConversation} CorpusConversation
 * @typedef {import('../metrics/retrieval.js').MetricsResult} MetricsResult
 */

/**
 * @typedef {object} SweepPoint
 * @property {Record<string, number>} overrides
 * @property {MetricsResult} metrics
 * @property {{p50: number, p95: number}} latencyMs
 */

/**
 * @typedef {object} SweepResult
 * @property {string} name
 * @property {SweepPoint[]} points
 * @property {{overrides: Record<string, number>, rationale: string}} elbow
 * @property {string} raw
 */

/**
 * Generate the cartesian product of knob value arrays.
 *
 * @param {Array<{name: string, values: number[]}>} knobs
 * @returns {Record<string, number>[]}
 */
function cartesianProduct(knobs) {
    if (knobs.length === 0) return [{}];
    const [first, ...rest] = knobs;
    const restProduct = cartesianProduct(rest);
    /** @type {Record<string, number>[]} */
    const result = [];
    for (const value of first.values) {
        for (const point of restProduct) {
            result.push({ [first.name]: value, ...point });
        }
    }
    return result;
}

/**
 * Compute p50 and p95 from an array of latency values (in ms).
 *
 * @param {number[]} latencies
 * @returns {{p50: number, p95: number}}
 */
function computeLatencyPercentiles(latencies) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return { p50: 0, p95: 0 };

    const idx50 = Math.floor((n - 1) * 0.5);
    const idx95 = Math.floor((n - 1) * 0.95);

    return {
        p50: sorted[idx50],
        p95: sorted[idx95],
    };
}

/**
 * Detect the elbow along the primary-knob axis.
 *
 * For each secondary-knob value held fixed, we sort points by the primary
 * knob, compute consecutive deltas, and pick the first point where the
 * delta drops below ELBOW_RATIO × maxDelta.  Among all secondary slices we
 * choose the elbow with the highest primary-metric value.
 *
 * @param {SweepPoint[]} points
 * @param {Array<{name: string, values: number[]}>} knobs
 * @param {string} primaryMetric
 * @returns {{overrides: Record<string, number>, rationale: string}}
 */
function detectElbow(points, knobs, primaryMetric) {
    const primaryKnob = knobs[0];
    const secondaryKnobs = knobs.slice(1);
    const accessor = METRIC_ACCESSORS[primaryMetric];

    /** @type {Array<{overrides: Record<string, number>, metric: number, rationale: string}>} */
    const elbows = [];

    if (secondaryKnobs.length === 0) {
        // Single-knob sweep
        const sorted = [...points].sort(
            (a, b) => a.overrides[primaryKnob.name] - b.overrides[primaryKnob.name]
        );
        const elbow = _elbowOnSlice(sorted, primaryKnob.name, accessor);
        if (elbow) elbows.push(elbow);
    } else {
        // Group by secondary knob values
        /** @type {Map<string, SweepPoint[]>} */
        const groups = new Map();
        for (const point of points) {
            const key = secondaryKnobs.map(k => `${k.name}=${point.overrides[k.name]}`).join(',');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(point);
        }

        for (const group of groups.values()) {
            const sorted = [...group].sort(
                (a, b) => a.overrides[primaryKnob.name] - b.overrides[primaryKnob.name]
            );
            const elbow = _elbowOnSlice(sorted, primaryKnob.name, accessor);
            if (elbow) elbows.push(elbow);
        }
    }

    if (elbows.length === 0) {
        // Fallback: return the point with the highest metric
        let best = points[0];
        let bestMetric = accessor(best.metrics);
        for (const p of points) {
            const m = accessor(p.metrics);
            if (m > bestMetric) {
                best = p;
                bestMetric = m;
            }
        }
        return {
            overrides: best.overrides,
            rationale: `No clear elbow detected; fallback to highest ${primaryMetric} = ${bestMetric.toFixed(4)}.`,
        };
    }

    // Choose the elbow with the highest primary-metric value
    let chosen = elbows[0];
    for (const e of elbows) {
        if (e.metric > chosen.metric) chosen = e;
    }

    return {
        overrides: chosen.overrides,
        rationale: chosen.rationale,
    };
}

/**
 * Elbow detection on a single slice sorted by primary knob.
 *
 * @param {SweepPoint[]} sorted
 * @param {string} primaryName
 * @param {(m: MetricsResult) => number} accessor
 * @returns {{overrides: Record<string, number>, metric: number, rationale: string}|null}
 */
function _elbowOnSlice(sorted, primaryName, accessor) {
    if (sorted.length < 2) return null;

    const metrics = sorted.map(p => accessor(p.metrics));
    const primaryValues = sorted.map(p => p.overrides[primaryName]);

    /** @type {number[]} */
    const deltas = [];
    for (let i = 0; i < metrics.length - 1; i++) {
        const deltaKnob = primaryValues[i + 1] - primaryValues[i];
        deltas.push(deltaKnob === 0 ? 0 : (metrics[i + 1] - metrics[i]) / deltaKnob);
    }

    const maxDelta = Math.max(...deltas.map(Math.abs));
    const threshold = ELBOW_RATIO * maxDelta + 1e-12;

    for (let i = 0; i < deltas.length; i++) {
        if (Math.abs(deltas[i]) <= threshold) {
            const elbowPoint = sorted[i];
            const elbowMetric = metrics[i];
            return {
                overrides: elbowPoint.overrides,
                metric: elbowMetric,
                rationale:
                    `Elbow at ${primaryName}=${primaryValues[i]} (metric=${elbowMetric.toFixed(4)}). ` +
                    `Δmetric/Δknob dropped to ${Math.abs(deltas[i]).toFixed(6)} ` +
                    `≤ ${ELBOW_RATIO}×maxΔ=${threshold.toFixed(6)}. ` +
                    `Chosen as the highest-metric elbow across secondary-knob slices.`,
            };
        }
    }

    return null;
}

/**
 * Run a parameter sweep.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {Array<{name: string, values: number[]}>} opts.knobs
 * @param {CorpusConversation[]} opts.corpus
 * @param {string} opts.primaryMetric
 * @param {(result: SweepResult) => void} [opts.onComplete]
 * @param {Function} [opts._runHarness]
 * @returns {Promise<SweepResult>}
 */
export async function sweep({
    name,
    knobs,
    corpus,
    primaryMetric,
    onComplete,
    _runHarness,
}) {
    const harness = _runHarness ?? runHarness;
    const grid = cartesianProduct(knobs);

    /** @type {SweepPoint[]} */
    const points = [];
    /** @type {string[]} */
    const jsonlLines = [];

    for (const overrides of grid) {
        const harnessResult = await harness({ corpus, overrides });

        const latencies = harnessResult.runs.map(r => r.latencyMs);
        const latencyMs = computeLatencyPercentiles(latencies);

        const point = {
            overrides,
            metrics: harnessResult.metrics,
            latencyMs,
        };

        points.push(point);
        jsonlLines.push(JSON.stringify({ overrides, metrics: harnessResult.metrics, latencyMs }));
    }

    const elbow = detectElbow(points, knobs, primaryMetric);

    /** @type {SweepResult} */
    const result = {
        name,
        points,
        elbow,
        raw: jsonlLines.join('\n') + (jsonlLines.length > 0 ? '\n' : ''),
    };

    if (onComplete) {
        onComplete(result);
    }

    return result;
}
