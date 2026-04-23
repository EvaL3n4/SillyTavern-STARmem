import { bm25only } from './bm25only.js';
import { recency } from './recency.js';
import { random } from './random.js';

export { bm25only, recency, random };

/** Ordered array of all baseline retrievers for harness loops. */
export const BASELINES = [
    { id: 'bm25only', fn: bm25only },
    { id: 'recency', fn: recency },
    { id: 'random', fn: random },
];

/** Canonical IDs including the ladder. Python-side Modal dispatch iterates this. */
export const BASELINE_IDS = ['ladder', 'bm25only', 'recency', 'random'];
