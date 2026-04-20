/**
 * STARmem structured logger. All STARmem code should use this instead of
 * bare console.* calls. Prefix is stable; debug channel is gated by a flag.
 *
 * @module core/logger
 */

/**
 * @typedef {object} LoggerOptions
 * @property {Console} [console] - Injectable console for testing.
 * @property {boolean} [debug] - If true, debug() calls reach the console.
 */

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 * @property {(...args: unknown[]) => void} debug
 * @property {(scope: string) => Logger} scope - Returns a child logger with scope appended to prefix.
 */

/**
 * Create a STARmem logger.
 *
 * @param {LoggerOptions} [opts]
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
    const _console = opts.console ?? globalThis.console;
    const debug = Boolean(opts.debug);
    return makeLogger(_console, debug, 'STARmem');
}

function makeLogger(_console, debug, prefix) {
    return {
        info: (...args) => _console.log(`[${prefix}]`, ...args),
        warn: (...args) => _console.warn(`[${prefix}]`, ...args),
        error: (...args) => _console.error(`[${prefix}]`, ...args),
        debug: (...args) => {
            if (debug) _console.debug(`[${prefix}:debug]`, ...args);
        },
        scope: (name) => makeLogger(_console, debug, `${prefix}:${name}`),
    };
}

/** Default module-level logger; debug off by default, flip via settings later. */
export const log = createLogger({ debug: false });
