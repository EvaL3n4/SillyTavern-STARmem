/**
 * Hand-rolled K-way concurrency limiter. Zero dependencies (SillyTavern
 * extensions cannot use `node_modules` at runtime — see AGENTS.md).
 *
 * Semantics match p-limit's minimal API:
 *   const limit = concurrencyLimit(K);
 *   const results = await Promise.all(tasks.map(t => limit(() => doWork(t))));
 *
 * Tasks are queued FIFO. Up to K run concurrently; the rest wait.
 * An active slot is released when its task settles (fulfilled OR
 * rejected) — one rejection does not poison the pool.
 *
 * @module bench/harness/concurrencyLimit
 */

/**
 * @template T
 * @param {number} max - Maximum concurrent tasks. Must be a positive integer.
 * @returns {(fn: () => Promise<T>) => Promise<T>}
 */
export function concurrencyLimit(max) {
    if (!Number.isInteger(max) || max < 1) {
        throw new Error(`concurrencyLimit: max must be a positive integer, got ${max}`);
    }

    let active = 0;
    /** @type {Array<() => void>} */
    const queue = [];

    const next = () => {
        if (active >= max || queue.length === 0) return;
        const run = queue.shift();
        if (run) run();
    };

    return function limit(fn) {
        return new Promise((resolve, reject) => {
            const run = () => {
                active++;
                Promise.resolve()
                    .then(fn)
                    .then(resolve, reject)
                    .finally(() => {
                        active--;
                        next();
                    });
            };
            queue.push(run);
            next();
        });
    };
}
