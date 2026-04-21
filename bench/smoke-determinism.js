#!/usr/bin/env node
/**
 * One-shot determinism smoke runner for sub-phase 9.4.5 Task 5.
 *
 * Seeds LoCoMo conv 1 via the real consolidation pipeline and prints the
 * seeder's stateHash + factCount. Runs back-to-back twice and shows the
 * diff so a human reader can verify they match post-9.4.5.
 *
 * Usage:
 *   node bench/smoke-determinism.js [rule-based|live]
 *
 * For `live`, source .env.bench first:
 *   (set -a; . .env.bench; set +a; node bench/smoke-determinism.js live)
 *
 * @see docs/plans/phase-9-4-5-id-determinism.md Task 5
 */

import { loadLocomo } from './loaders/locomo.js';
import { seedConversation } from './harness/seeder.js';
import { _resetBackendForTests } from '../src/core/state.js';
import { _resetLocksForTests } from '../src/core/lock.js';

async function runOnce(conv, label) {
    const t0 = Date.now();
    const r = await seedConversation(conv, {
        chatIdPrefix: `smoke-det-${label}`,
        now: new Date('2026-04-20T10:00:00Z'),
    });
    const wallMs = Date.now() - t0;
    return {
        stateHash: r.stateHash,
        factCount: r.factCount,
        wallMs,
    };
}

function short(h) { return h.slice(0, 12); }

(async () => {
    const mode = process.argv[2] || 'rule-based';
    if (mode === 'live') {
        process.env.STARMEM_BENCH_LIVE_EXTRACTOR = '1';
        const need = ['STARMEM_BENCH_LLM_URL', 'STARMEM_BENCH_LLM_API_KEY', 'STARMEM_BENCH_LLM_MODEL'];
        for (const k of need) {
            if (!process.env[k]) {
                console.error(`Missing env: ${k}. Source .env.bench first.`);
                process.exit(1);
            }
        }
    } else {
        process.env.STARMEM_BENCH_LIVE_EXTRACTOR = '0';
    }

    console.log(`\n=== Determinism smoke: ${mode} (LoCoMo conv 1) ===`);

    const corpus = await loadLocomo({ maxConversations: 1, offline: true });
    const conv = corpus[0];
    console.log(`conv.id=${conv.id} turns=${conv.turns.length} qa=${conv.qa.length}`);

    console.log('\n--- Run 1 ---');
    _resetBackendForTests();
    _resetLocksForTests();
    const r1 = await runOnce(conv, 'run1');
    console.log(`factCount=${r1.factCount}  stateHash=${short(r1.stateHash)}  wallMs=${r1.wallMs}`);

    console.log('\n--- Run 2 (fresh backend) ---');
    _resetBackendForTests();
    _resetLocksForTests();
    const r2 = await runOnce(conv, 'run2');
    console.log(`factCount=${r2.factCount}  stateHash=${short(r2.stateHash)}  wallMs=${r2.wallMs}`);

    console.log('\n--- Verdict ---');
    const hashMatch = r1.stateHash === r2.stateHash;
    const countMatch = r1.factCount === r2.factCount;
    console.log(`stateHash match: ${hashMatch ? 'YES' : 'NO'}`);
    console.log(`factCount match: ${countMatch ? 'YES' : 'NO'}`);

    if (hashMatch && countMatch) {
        console.log('\n✓ Determinism restored.');
        process.exit(0);
    } else {
        console.log('\n✗ DRIFT — investigate before proceeding to 9.5 sweeps.');
        process.exit(2);
    }
})().catch(err => {
    console.error('smoke failed:', err);
    process.exit(1);
});
