/**
 * Consolidation indicator — a subtle dot that pulses while consolidation is
 * running. Mounted once on APP_READY; polls state.runtime.consolidating via
 * loadState() on a 1-second interval.
 *
 * Idle state: a quiet always-visible muted dot at 0.4 opacity.
 * Busy state: theme-accent dot with a 1.4s gentle pulse (Quiet Library).
 *
 * Mount target: `#send_form` (ST's stable input-bar wrapper). On desktop the
 * CSS uses `position: fixed` + bottom-right viewport coordinates so the dot
 * sits in the bottom corner regardless of DOM parent. On mobile, the CSS
 * switches to `position: absolute` + top-right relative to `#send_form` so
 * the dot rides at the top edge of the send bar instead of being clipped by
 * the on-screen keyboard or send-form chrome that covers the viewport
 * bottom-right corner. Falls back to `document.body` + fixed positioning
 * if `#send_form` isn't present at mount time (defensive — should be rare,
 * since send_form is part of the always-rendered chat surface).
 *
 * Note: an earlier draft (Phase 8 Decision 14.B) targeted `#send_but_container`,
 * which never existed in current SillyTavern. P16 T5 corrected this to
 * `#send_form` and pinned mobile behavior at the same time.
 *
 * @module integration/indicator
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { loadState } from '../core/state.js';
import { CSS_PREFIX } from './constants.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:indicator');

const INDICATOR_ID = `${CSS_PREFIX}-indicator`;
const POLL_INTERVAL_MS = 1000;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalId = null;
/** @type {HTMLElement | null} */
let el = null;
/** @type {(() => string | null) | null} */
let chatIdResolver = null;

/**
 * Mount the indicator. Idempotent — removes prior mount before creating a new one.
 *
 * @param {() => string | null} getChatId - called each tick to resolve current chat
 */
export function mountIndicator(getChatId) {
    unmountIndicator();
    chatIdResolver = getChatId;

    const dot = document.createElement('div');
    dot.id = INDICATOR_ID;
    dot.className = `${CSS_PREFIX}-indicator`;
    dot.setAttribute('role', 'status');
    dot.setAttribute('aria-label', 'STARmem consolidation');
    dot.title = 'STARmem: idle';
    dot.classList.add(`${CSS_PREFIX}-indicator-idle`);

    // Mount inside ST's send form. style.css sets `#send_form { position:
    // relative }` so the mobile breakpoint's `position: absolute` rule
    // anchors here. On desktop the CSS uses `position: fixed` regardless
    // of DOM parent, so the dot sits in the viewport's bottom-right corner.
    const anchor = document.getElementById('send_form');
    if (anchor) {
        anchor.appendChild(dot);
    } else {
        log.debug('#send_form not found; falling back to document.body');
        dot.classList.add(`${CSS_PREFIX}-indicator-floating`);
        document.body.appendChild(dot);
    }
    el = dot;

    intervalId = setInterval(tick, POLL_INTERVAL_MS);
    log.debug(`mounted @ #${INDICATOR_ID}, polling every ${POLL_INTERVAL_MS}ms`);
}

/** Unmount + remove any DOM. Idempotent. */
export function unmountIndicator() {
    if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
    }
    // Remove by id defensively — module instance may have been re-loaded in
    // dev mode and lost its `el` reference.
    const existing = document.getElementById(INDICATOR_ID);
    if (existing) existing.remove();
    el = null;
    chatIdResolver = null;
}

/** Test-only: step one poll deterministically without waiting for the interval. */
export async function _tickForTests() { await tick(); }

async function tick() {
    if (!el || !chatIdResolver) return;
    try {
        const chatId = chatIdResolver();
        if (!chatId) {
            setIdle();
            return;
        }
        const state = await loadState(chatId);
        const isConsolidating = Boolean(state?.runtime?.consolidating);
        if (isConsolidating) setBusy(state?.runtime);
        else setIdle();
    } catch (err) {
        // Swallow — indicator must never break the UI.
        setIdle();
        log.debug(`tick error: ${err?.message || err}`);
    }
}

function setIdle() {
    if (!el) return;
    el.classList.remove(`${CSS_PREFIX}-indicator-busy`);
    el.classList.add(`${CSS_PREFIX}-indicator-idle`);
    el.title = 'STARmem: idle';
}

/**
 * @param {{ consolidating?: boolean, lastConsolidation?: string | null } | undefined} runtime
 */
function setBusy(runtime) {
    if (!el) return;
    el.classList.remove(`${CSS_PREFIX}-indicator-idle`);
    el.classList.add(`${CSS_PREFIX}-indicator-busy`);
    const last = runtime?.lastConsolidation;
    if (typeof last === 'string' && last.length > 0) {
        el.title = `STARmem: consolidating (last run: ${last})`;
    } else {
        el.title = 'STARmem: consolidating';
    }
}
