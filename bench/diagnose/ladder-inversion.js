#!/usr/bin/env node
/**
 * Ladder inversion diagnostic runner.
 *
 * Seeds 1–2 LoCoMo conversations (or the synthetic corpus if LoCoMo is
 * unavailable), replays 10–20 QA queries through both ladder and bm25only,
 * and emits a JSON factor dump for audit rendering.
 *
 * Usage:
 *   node bench/diagnose/ladder-inversion.js [--conversations N] [--out path.json]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHarness } from '../runner.js';
import { bm25only } from '../baselines/bm25only.js';
import { loadLocomo } from '../loaders/index.js';
import { retrieve } from '../../src/retrieval/ladder.js';
import { tier2 } from '../../src/retrieval/tier2-bm25.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { conversations: 2, out: '' };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--conversations' && args[i + 1]) {
            opts.conversations = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--out' && args[i + 1]) {
            opts.out = args[i + 1];
            i++;
        }
    }
    return opts;
}

async function main() {
    const opts = parseArgs();
    const corpus = await loadLocomo({ maxConversations: opts.conversations });
    if (corpus.length === 0) {
        console.error('No corpus loaded. Ensure LoCoMo data is available.');
        process.exit(1);
    }

    // Run ladder harness (default retriever — retrieve() itself)
    const ladderResult = await runHarness({
        corpus,
        retriever: retrieve,
    });

    // Run bm25only baseline on same corpus
    const bm25Result = await runHarness({
        corpus,
        retriever: bm25only,
    });

    // For each run, capture rank diffs
    const audits = [];
    for (let i = 0; i < ladderResult.runs.length; i++) {
        const ladderRun = ladderResult.runs[i];
        const bm25Run = bm25Result.runs[i];

        audits.push({
            conversationId: ladderRun.conversationId,
            question: ladderRun.qa.question,
            ladderTop10: ladderRun.retrieved.slice(0, 10).map(r => ({
                id: r.id,
                score: r.score,
                tier: r.tier,
            })),
            bm25Top10: bm25Run.retrieved.slice(0, 10).map(r => ({
                id: r.id,
                score: r.score,
            })),
            goldTurns: ladderRun.goldTurns.map(g => g.turnIndex),
        });
    }

    // Diagnostic tier2 pass: re-seed conversations and run tier2 with diagnostic=true
    const { seedConversation } = await import('../harness/seeder.js');
    const { loadState } = await import('../../src/core/state.js');
    const diagnosticDetails = [];
    for (const conv of corpus.slice(0, opts.conversations)) {
        const seedResult = await seedConversation(conv, { chatIdPrefix: 'diag', keepBackend: true });
        const seededState = await loadState(seedResult.chatId);
        for (const qa of conv.qa.slice(0, 10)) {
            const t2 = tier2(seededState, qa.question, {
                now: new Date(),
                intent: 'factual',
                k: 10,
                diagnostic: true,
            });
            diagnosticDetails.push({
                conversationId: conv.id,
                question: qa.question,
                tier2Top10: t2.scored.slice(0, 10).map(s => ({
                    id: s.entry.id,
                    bm25: s.bm25,
                    score: s.score,
                    factors: s.factors ?? null,
                })),
                goldEvidenceTurns: qa.evidenceTurns,
            });
        }
    }

    const payload = {
        meta: {
            generatedAt: new Date().toISOString(),
            conversations: corpus.length,
            queriesAudited: audits.length,
            nodeVersion: process.version,
        },
        audits,
        diagnosticDetails,
    };

    const outPath = opts.out || path.join(__dirname, '..', '..', 'docs', 'bench', 'audits', 'ladder-inversion-raw.json');
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(payload, null, 2));
    console.log(`Wrote raw audit data to ${outPath}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
