#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

async function main() {
    const raw = JSON.parse(await readFile(process.argv[2] || '/tmp/ladder-inversion-raw.json', 'utf8'));
    const lines = [];
    lines.push('# Ladder Inversion Audit — 2026-04-22');
    lines.push('');
    lines.push(`**Generated:** ${raw.meta.generatedAt}`);
    lines.push(`**Conversations:** ${raw.meta.conversations}`);
    lines.push(`**Queries audited:** ${raw.meta.queriesAudited}`);
    lines.push('');

    // Factor distribution from diagnosticDetails
    const allFactors = [];
    for (const d of raw.diagnosticDetails) {
        for (const t of d.tier2Top10) {
            if (t.factors) allFactors.push(t.factors);
        }
    }
    if (allFactors.length > 0) {
        lines.push('## Factor Distribution (tier2 diagnostic top-10)');
        lines.push('');
        const recencyFactors = allFactors.map(f => f.recencyFactor).sort((a, b) => a - b);
        const maturityFactors = allFactors.map(f => f.maturityFactor);
        const importanceFactors = allFactors.map(f => f.importanceFactor);
        const ratios = allFactors.map(f => (f.recencyFactor * f.maturityFactor * f.importanceFactor));
        lines.push(`| factor | min | p50 | max |`);
        lines.push(`|---|---|---|---|`);
        lines.push(`| recencyFactor | ${recencyFactors[0].toFixed(4)} | ${recencyFactors[Math.floor(recencyFactors.length / 2)].toFixed(4)} | ${recencyFactors[recencyFactors.length - 1].toFixed(4)} |`);
        lines.push(`| maturityFactor | ${Math.min(...maturityFactors).toFixed(2)} | — | ${Math.max(...maturityFactors).toFixed(2)} |`);
        lines.push(`| importanceFactor | ${Math.min(...importanceFactors).toFixed(2)} | ${importanceFactors.sort((a, b) => a - b)[Math.floor(importanceFactors.length / 2)].toFixed(2)} | ${Math.max(...importanceFactors).toFixed(2)} |`);
        lines.push(`| total multiplier | ${Math.min(...ratios).toFixed(4)} | ${ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)].toFixed(4)} | ${Math.max(...ratios).toFixed(4)} |`);
        lines.push('');
    }

    // Per-query diffs
    lines.push('## Per-Query Rank Diff (ladder vs bm25only)');
    lines.push('');
    for (let i = 0; i < Math.min(raw.audits.length, 20); i++) {
        const a = raw.audits[i];
        lines.push(`### Q${i + 1}: ${a.question}`);
        lines.push('');
        lines.push(`**Conversation:** ${a.conversationId} | **Gold turns:** ${a.goldTurns.join(', ')}`);
        lines.push('');
        lines.push('| rank | ladder (id / score / tier) | bm25only (id / score) |');
        lines.push('|---|---|---|');
        for (let r = 0; r < 10; r++) {
            const l = a.ladderTop10[r];
            const b = a.bm25Top10[r];
            const lStr = l ? `${l.id} / ${l.score.toFixed(4)} / ${l.tier}` : '—';
            const bStr = b ? `${b.id} / ${b.score.toFixed(4)}` : '—';
            lines.push(`| ${r + 1} | ${lStr} | ${bStr} |`);
        }
        lines.push('');
    }

    // Hypothesis verdict section (subagent fills in after analysis)
    lines.push('## Hypothesis Verdict');
    lines.push('');
    lines.push('> **Subagent:** After analyzing the tables above, fill in the verdict below.');
    lines.push('');
    lines.push('### H1 — Recency Dominance');
    lines.push('');
    lines.push('- **Verdict:** <!-- supported / not supported / partial -->');
    lines.push('- **Evidence:** <!-- e.g., "Gold entry recencyFactor = 0.03 vs top-5 average = 0.85" -->');
    lines.push('');
    lines.push('### H2 — Maturity Compression');
    lines.push('');
    lines.push('- **Verdict:** <!-- supported / not supported / partial -->');
    lines.push('- **Evidence:** <!-- e.g., "63% of tier2 candidates are draft (maturityFactor 0.85); gold entries skew draft in 14/20 queries, distractors skew validated in 12/20, producing systematic rank advantage for non-draft entries" -->');
    lines.push('');
    lines.push('### H3 — Pool Mismatch');
    lines.push('');
    lines.push('- **Verdict:** <!-- supported / not supported / partial -->');
    lines.push('- **Evidence:** <!-- e.g., "bm25only pool = 1247, tier2 pool = 1198; gold entry is episodic in all 20 queries" -->');
    lines.push('');
    lines.push('## Gate Recommendation');
    lines.push('');
    lines.push('> **Subagent:** After filling in the verdicts above, set ONE of the following:');
    lines.push('');
    lines.push('```');
    lines.push('GATE_VERDICT = NARROW_FIX');
    lines.push('GATE_TARGET_FILE = src/retrieval/scorer.js  // or tier2-bm25.js, ladder.js, etc.');
    lines.push('GATE_FIX_DESCRIPTION = "Reduce recency tau from 30 days to 90 days"  // example');
    lines.push('```');
    lines.push('');
    lines.push('OR');
    lines.push('');
    lines.push('```');
    lines.push('GATE_VERDICT = STRUCTURAL');
    lines.push('GATE_RECOMMENDATION = "Phase 11: redesign scorer chain to use additive combination instead of multiplicative"  // example');
    lines.push('```');
    lines.push('');

    await writeFile('docs/bench/audits/2026-04-22-ladder-inversion.md', lines.join('\n'));
    console.log('Wrote docs/bench/audits/2026-04-22-ladder-inversion.md');
}

main().catch(e => { console.error(e); process.exit(1); });
