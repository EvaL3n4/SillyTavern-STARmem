import modal
import json

app = modal.App("starmem-bench")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .run_commands(
        "apt-get update && apt-get install -y curl ca-certificates git",
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
    )
    .add_local_dir(
        "/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem",
        "/repo",
    )
)

volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)

# Inject .env.bench into the container at function runtime.
# The extraction cache is keyed by (model, messages, maxTokens), so
# STARMEM_BENCH_LLM_MODEL must match what the cache was generated with
# — otherwise every lookup misses and the runner falls through to
# rule-based extraction, producing systematically fewer episodic facts.
# .env.bench is read from the host's cwd (repo root) at `modal run` time.
env_secret = modal.Secret.from_dotenv(filename=".env.bench")


@app.function(image=image, volumes={"/data": volume}, timeout=600, memory=4096)
def hello():
    import os
    import subprocess
    corpus_exists = os.path.exists("/data/locomo10.json")
    cache_exists = os.path.exists("/data/extractions")
    return {
        "nodeVersion": subprocess.run(
            ["node", "--version"],
            cwd="/repo",
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip(),
        "corpusOnVolume": corpus_exists,
        "cacheOnVolume": cache_exists,
    }

@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=600,
    memory=4096,
)
def run_point(overrides_json: str) -> str:
    """Run a single sweep point.

    Args:
        overrides_json: JSON string of Record<string, number> overrides.

    Returns:
        JSON string with { overrides, metrics, latencyMs, runCount, wallMs }.
    """
    import os
    import subprocess

    # Symlink Volume cache to where the repo expects it.
    # NOTE: add_local_dir may or may not have copied bench/.cache/ into
    # /repo (depends on gitignore handling). If it did, the existing
    # guards prevent overwriting. If it didn't, we create the symlinks.
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    # Diagnostic: collect filesystem state before running Node.
    diag = {
        "repo_cache_contents": sorted(os.listdir(repo_cache)) if os.path.isdir(repo_cache) else None,
        "corpus_link_target": os.readlink(corpus_link) if os.path.islink(corpus_link) else "not-a-symlink",
        "corpus_link_size": os.path.getsize(corpus_link) if os.path.exists(corpus_link) else 0,
        "cache_link_target": os.readlink(cache_link) if os.path.islink(cache_link) else "not-a-symlink",
        "cache_link_isdir": os.path.isdir(cache_link),
        "modal_point_js_exists": os.path.exists("/repo/bench/sweeps/_modal-point.js"),
        "runner_js_exists": os.path.exists("/repo/bench/runner.js"),
        "node_modules_exists": os.path.exists("/repo/node_modules"),
    }

    env = os.environ.copy()
    env["STARMEM_OVERRIDES"] = overrides_json

    # check=False — we want to surface stderr on non-zero exit, not raise.
    result = subprocess.run(
        ["node", "bench/sweeps/_modal-point.js"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        import json as _json
        return _json.dumps({
            "error": "node subprocess failed",
            "returncode": result.returncode,
            "stderr": result.stderr,
            "stdout_tail": result.stdout[-2000:] if result.stdout else "",
            "diagnostics": diag,
        }, indent=2)
    return result.stdout.strip()


def _detect_elbow(points, knobs, primary_metric):
    """Python port of _driver.js detectElbow.

    Args:
        points: list of dicts with 'overrides' and 'metrics'.
        knobs: list of {name, values} dicts.
        primary_metric: string key into METRIC_ACCESSORS.

    Returns:
        dict with 'overrides' and 'rationale'.
    """
    ELBOW_RATIO = 0.1

    def accessor(m):
        # NOTE: JSON parses integer-looking keys as strings, so recallAtK/
        # precisionAtK come back keyed by "1", "3", "5", "10" — not ints.
        # All lookups in this module must use string keys.
        if primary_metric == "recallAt5":
            return m["recallAtK"]["5"]
        if primary_metric == "recallAt10":
            return m["recallAtK"]["10"]
        if primary_metric == "precisionAt3":
            return m["precisionAtK"]["3"]
        if primary_metric == "precisionAt5":
            return m["precisionAtK"]["5"]
        return m["mrr"]

    primary_knob = knobs[0]
    secondary_knobs = knobs[1:]

    elbows = []

    if not secondary_knobs:
        sorted_pts = sorted(points, key=lambda p: p["overrides"][primary_knob["name"]])
        elbow = _elbow_on_slice(sorted_pts, primary_knob["name"], accessor, ELBOW_RATIO)
        if elbow:
            elbows.append(elbow)
    else:
        groups = {}
        for p in points:
            key = ",".join(f"{k['name']}={p['overrides'][k['name']]}" for k in secondary_knobs)
            groups.setdefault(key, []).append(p)
        for group in groups.values():
            sorted_pts = sorted(group, key=lambda p: p["overrides"][primary_knob["name"]])
            elbow = _elbow_on_slice(sorted_pts, primary_knob["name"], accessor, ELBOW_RATIO)
            if elbow:
                elbows.append(elbow)

    if not elbows:
        best = max(points, key=lambda p: accessor(p["metrics"]))
        best_metric = accessor(best["metrics"])
        return {
            "overrides": best["overrides"],
            "rationale": f"No clear elbow detected; fallback to highest {primary_metric} = {best_metric:.4f}.",
        }

    chosen = max(elbows, key=lambda e: e["metric"])
    return {
        "overrides": chosen["overrides"],
        "rationale": chosen["rationale"],
    }


def _elbow_on_slice(sorted_pts, primary_name, accessor, ratio):
    if len(sorted_pts) < 2:
        return None

    metrics = [accessor(p["metrics"]) for p in sorted_pts]
    primary_values = [p["overrides"][primary_name] for p in sorted_pts]

    deltas = []
    for i in range(len(metrics) - 1):
        delta_knob = primary_values[i + 1] - primary_values[i]
        deltas.append(0 if delta_knob == 0 else (metrics[i + 1] - metrics[i]) / delta_knob)

    max_delta = max(abs(d) for d in deltas)
    threshold = ratio * max_delta + 1e-12

    for i, d in enumerate(deltas):
        if abs(d) <= threshold:
            return {
                "overrides": sorted_pts[i]["overrides"],
                "metric": metrics[i],
                "rationale": (
                    f"Elbow at {primary_name}={primary_values[i]} (metric={metrics[i]:.4f}). "
                    f"Δmetric/Δknob dropped to {abs(d):.6f} "
                    f"≤ {ratio}×maxΔ={threshold:.6f}. "
                    f"Chosen as the highest-metric elbow across secondary-knob slices."
                ),
            }
    return None


def render_tau_report(result, corpus_len, qa_count):
    """Port of tau.js renderReport to Python."""
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    primary_metric = "recallAt5"

    header = "| TIER2_TAU_CONFIDENCE | TIER2_TAU_GAP | recallAt5 | precisionAt3 | mrr | p50 | p95 |"
    separator = "|---|---|---|---|---|---|---|"
    rows = []
    for p in result["points"]:
        tc = p["overrides"]["TIER2_TAU_CONFIDENCE"]
        tg = p["overrides"]["TIER2_TAU_GAP"]
        r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
        p3 = f"{p['metrics']['precisionAtK']['3']:.4f}"
        mrr = f"{p['metrics']['mrr']:.4f}"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {tc} | {tg} | {r5} | {p3} | {mrr} | {p50} | {p95} |")

    # Heatmap
    tau_gap_values = sorted({p["overrides"]["TIER2_TAU_GAP"] for p in result["points"]})
    tau_conf_values = sorted({p["overrides"]["TIER2_TAU_CONFIDENCE"] for p in result["points"]})
    gap_header = "               " + "".join(f"{v:.2f}".rjust(5) + "  " for v in tau_gap_values).rstrip()
    heatmap_rows = []
    for tc in tau_conf_values:
        cells = []
        for tg in tau_gap_values:
            point = next(
                (p for p in result["points"]
                 if p["overrides"]["TIER2_TAU_CONFIDENCE"] == tc and p["overrides"]["TIER2_TAU_GAP"] == tg),
                None,
            )
            val = f"{point['metrics']['recallAtK']['5']:.2f}" if point else "N/A"
            cells.append(val.rjust(5))
        heatmap_rows.append(f"  {str(tc).ljust(4)}   {'  '.join(cells)}")

    # Spec amendment
    current_tau_conf = 2.0
    current_tau_gap = 0.5
    e_conf = result["elbow"]["overrides"]["TIER2_TAU_CONFIDENCE"]
    e_gap = result["elbow"]["overrides"]["TIER2_TAU_GAP"]
    conf_deviation = abs(e_conf - current_tau_conf) / current_tau_conf
    gap_deviation = abs(e_gap - current_tau_gap) / current_tau_gap
    needs_amendment = conf_deviation > 0.5 or gap_deviation > 0.5

    if needs_amendment:
        amendment_section = (
            f"**Proposed amendment:**\n\n"
            f"- TIER2_TAU_CONFIDENCE: {current_tau_conf} → {e_conf}\n"
            f"- TIER2_TAU_GAP: {current_tau_gap} → {e_gap}\n\n"
            f"Rationale: elbow is >50% away from current spec values ({conf_deviation*100:.0f}% / {gap_deviation*100:.0f}% deviation)."
        )
    else:
        amendment_section = "No amendment needed — elbow within 50% of current spec."

    first_point = result["points"][0] if result["points"] else None
    env_block = (
        "```json\n" + json.dumps(first_point["metrics"], indent=2) + "\n```"
        if first_point else "No points recorded."
    )

    rows_joined = "\n".join(rows)
    heatmap_rows_joined = "\n".join(heatmap_rows)

    report = f"""# τ sweep — {today}

**Corpus:** {corpus_len} conversations, {qa_count} QA items
**Primary metric:** {primary_metric}

## Points

{header}
{separator}
{rows_joined}

## Heatmap (primary = {primary_metric})

               TIER2_TAU_GAP
{gap_header}
TIER2_TAU_CONFIDENCE
{heatmap_rows_joined}

## Elbow

**Recommended overrides:** `{json.dumps(result['elbow']['overrides'])}`
**Rationale:** {result['elbow']['rationale']}

## Spec amendment proposal

{amendment_section}

## Environment snapshot

{env_block}
"""
    return report


def render_bm25_report(result, corpus_len, qa_count, tags_stats):
    """Port of bm25.js renderReport to Python."""
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    primary_metric = "mrr"

    tags_rate_pct = f"{tags_stats['rate'] * 100:.1f}"
    tags_line = f"**Tags populated rate:** {tags_rate_pct}% of {tags_stats['n']} episodic entries have non-empty tags."
    tags_interpretation = (
        "(If <5%, TAG_BOOST axis is meaningless on this corpus; treat tag-axis results as structural, not signal.)"
        if tags_stats["rate"] < 0.05 else ""
    )

    header = "| TAG_BOOST | SUBJECT_BOOST | recallAt5 | precisionAt3 | mrr | p50 | p95 |"
    separator = "|---|---|---|---|---|---|---|"
    rows = []
    for p in result["points"]:
        tb = p["overrides"]["TAG_BOOST"]
        sb = p["overrides"]["SUBJECT_BOOST"]
        r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
        p3 = f"{p['metrics']['precisionAtK']['3']:.4f}"
        mrr = f"{p['metrics']['mrr']:.4f}"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {tb} | {sb} | {r5} | {p3} | {mrr} | {p50} | {p95} |")

    # Heatmap
    subject_values = sorted({p["overrides"]["SUBJECT_BOOST"] for p in result["points"]})
    tag_values = sorted({p["overrides"]["TAG_BOOST"] for p in result["points"]})
    subj_header = "               " + "".join(f"{str(v).rjust(5)}  " for v in subject_values).rstrip()
    heatmap_rows = []
    for tb in tag_values:
        cells = []
        for sb in subject_values:
            point = next(
                (p for p in result["points"]
                 if p["overrides"]["TAG_BOOST"] == tb and p["overrides"]["SUBJECT_BOOST"] == sb),
                None,
            )
            val = f"{point['metrics']['mrr']:.2f}" if point else "N/A"
            cells.append(val.rjust(5))
        heatmap_rows.append(f"  {str(tb).ljust(4)}   {'  '.join(cells)}")

    # Flatness check
    all_primary = [p["metrics"]["mrr"] for p in result["points"]]
    max_primary = max(all_primary)
    min_primary = min(all_primary)
    is_flat = (max_primary - min_primary) < 0.01

    e_tag = result["elbow"]["overrides"]["TAG_BOOST"]
    e_sub = result["elbow"]["overrides"]["SUBJECT_BOOST"]

    if is_flat:
        interpretation_branch = (
            f"### Branch C — flat heatmap (max - min of primary metric < 0.01 across all 16 cells)\n"
            f"Rule-based extractor can't exercise tag/subject asymmetry on this corpus. Defer to sub-phase 9.5 for meaningful numbers. Tags populated rate of {tags_rate_pct}% confirms the mechanism."
        )
    elif e_sub > e_tag:
        interpretation_branch = (
            f"### Branch A — subject > tag (elbow has SUBJECT_BOOST > TAG_BOOST)\n"
            f"As-expected: subject matches dominate in well-formed retrievals.\n"
            f"Consider accepting SUBJECT_BOOST={e_sub} as a spec amendment if >50% from current default."
        )
    else:
        interpretation_branch = (
            f"### Branch B — tag > subject (elbow has TAG_BOOST > SUBJECT_BOOST)\n"
            f"Investigate: suggests entries have bogus tags or subject-extraction is weak. Do NOT amend spec without root-cause inspection."
        )

    current_tag_boost = 2
    current_subject_boost = 2
    tag_deviation = abs(e_tag - current_tag_boost) / current_tag_boost
    subj_deviation = abs(e_sub - current_subject_boost) / current_subject_boost
    needs_amendment = tag_deviation > 0.5 or subj_deviation > 0.5

    if needs_amendment:
        amendment_section = (
            f"**Proposed amendment:**\n\n"
            f"- TAG_BOOST: {current_tag_boost} → {e_tag}\n"
            f"- SUBJECT_BOOST: {current_subject_boost} → {e_sub}\n\n"
            f"Rationale: elbow is >50% away from current spec values ({tag_deviation*100:.0f}% / {subj_deviation*100:.0f}% deviation)."
        )
    else:
        amendment_section = "No amendment needed — elbow within 50% of current spec."

    first_point = result["points"][0] if result["points"] else None
    env_block = (
        "```json\n" + json.dumps(first_point["metrics"], indent=2) + "\n```"
        if first_point else "No points recorded."
    )

    rows_joined = "\n".join(rows)
    heatmap_rows_joined = "\n".join(heatmap_rows)

    report = f"""# BM25 boost sweep — {today}

**Corpus:** {corpus_len} conversations, {qa_count} QA items
**Primary metric:** {primary_metric}
{tags_line}
{tags_interpretation}

## Per-pair metrics table

{header}
{separator}
{rows_joined}

## Heatmap (primary = {primary_metric})

              SUBJECT_BOOST
{subj_header}
TAG_BOOST
{heatmap_rows_joined}

## Elbow

**Recommended overrides:** `{json.dumps(result['elbow']['overrides'])}`
**Rationale:** {result['elbow']['rationale']}

## Interpretation

{interpretation_branch}

## v2.1 tokenizer refactor note

If the elbow suggests fractional values would help (any "would like X.5"
indication from Phase 3's retro), a v2.1 refactor is warranted at
`src/retrieval/bm25.js:62-63`:

```js
// Current (integer-only):
...repeat(subjectTokens, RETRIEVAL.SUBJECT_BOOST),
...repeat(tagTokens, RETRIEVAL.TAG_BOOST),

// Proposed (fractional-capable): per-token weight multiplier into the
// BM25 scoring matrix instead of token replication. Requires bm25.js
// interface change; downstream effect on tier2-bm25.js scoring path.
```

Not in scope for Phase 9 — note only.

## Spec amendment proposal

{amendment_section}

## envSnapshot

{env_block}
"""
    return report


SWEEP_CONFIGS = {
    "tau": {
        "knobs": [
            # Validation sweep — combined amended spec.
            # 9.4.8 sweeps found:
            #   TIER2_TAU_CONFIDENCE inert across 0.5-5.0 (hold at 2.0)
            #   TIER2_TAU_GAP plateau at ~10 (+0.0625 MRR absolute)
            #   TAG_BOOST peaks at 3 (+0.0098 MRR absolute)
            #   SUBJECT_BOOST inert on LoCoMo (hold at 2)
            # Single-point confirmation that gap=10 and tag=3 compose
            # additively. Expected MRR ~0.81 if both effects stack cleanly.
            {"name": "TIER2_TAU_GAP", "values": [10]},
            {"name": "TIER2_TAU_CONFIDENCE", "values": [2.0]},
            {"name": "TAG_BOOST", "values": [3]},
            {"name": "SUBJECT_BOOST", "values": [2]},
        ],
        "primary_metric": "recallAt5",
        "renderer": render_tau_report,
    },
    "bm25": {
        "knobs": [
            {"name": "TAG_BOOST", "values": [1, 2, 3, 4]},
            {"name": "SUBJECT_BOOST", "values": [1, 2, 3, 4]},
        ],
        "primary_metric": "mrr",
        "renderer": render_bm25_report,
    },
}


# 9.4.9 — graph sweep coordinate descent.
# Mirrors bench/sweeps/graph.js:254-269. Each round pins previous
# rounds' winners as baseOverrides and sweeps one knob. Winner =
# point with highest MRR in the round. TIER3_SEEDS_K round is new
# in 9.4.9 (was pinned at spec default 3 pre-9.4.8).
GRAPH_ROUNDS = [
    {"name": "lambda_1",     "knob": "TIER3_LAMBDA_1",      "values": [0.5, 0.75, 1.0, 1.25, 1.5]},
    {"name": "lambda_2",     "knob": "TIER3_LAMBDA_2",      "values": [0.1, 0.2, 0.3, 0.4, 0.5]},
    {"name": "beam",         "knob": "TIER3_BEAM_WIDTH",    "values": [3, 5, 8, 10]},
    {"name": "seeds_k",      "knob": "TIER3_SEEDS_K",       "values": [1, 3, 5, 7]},
    {"name": "edge_cap",     "knob": "EDGE_CAP_PER_ENTRY",  "values": [10, 15, 20, 30, 50]},
    {"name": "cooccurrence", "knob": "COOCCURRENCE_WEIGHT", "values": [0.25, 0.5, 0.75, 1.0]},
]

# Every point in every graph round runs with TIER2_TAU_GAP=10
# (9.4.8 amendment). Without this baseOverride, Tier 2 shortcut fires
# for most queries and graph knobs don't affect retrieval because
# queries never reach Tier 3.
GRAPH_BASE_OVERRIDES = {"TIER2_TAU_GAP": 10}


def render_graph_report_stub(payload):
    """Minimal stub renderer — Task 5 replaces with the full port.

    Produces a usable-but-terse Markdown that lists each round's
    winner so synthetic smoke has something to eyeball. The full
    renderer with per-round tables, composite elbow, and spec
    amendment proposal lands in Task 5.
    """
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    lines = [
        f"# Graph sweep — {today} (STUB renderer, Task 5 ships full)",
        "",
        f"**Corpus:** {payload['corpus_len']} conversations, {payload['qa_count']} QA items",
        f"**Base overrides:** `{json.dumps(payload['base_overrides'])}`",
        f"**Rounds:** {len(payload['rounds'])}",
        "",
        "## Round winners",
        "",
        "| Round | Knob | Values | Winner value | Winner MRR |",
        "|---|---|---|---|---|",
    ]
    for r in payload["rounds"]:
        values_str = str(r["values"])
        lines.append(
            f"| {r['name']} | `{r['knob']}` | {values_str} | "
            f"`{r['winner']['value']}` | {r['winner']['mrr']:.4f} |"
        )
    lines.append("")
    lines.append("## Composite elbow")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(payload["composite_elbow"]["overrides"], indent=2))
    lines.append("```")
    lines.append("")
    lines.append("_Stub output; Task 5 ships `render_graph_report` with per-round tables and spec amendment proposal._")
    return "\n".join(lines)


def run_graph_sweep(synthetic: bool = False) -> dict:
    """Run the 6-round graph coordinate descent.

    Each round sweeps one knob via run_point.map() (parallel across
    containers within the round), picks the MRR-best point as the
    winner, and pins that value in accumulated_overrides for the
    next round. Synthetic mode shrinks each round's grid to 2 points
    for smoke testing; corpus stays full LoCoMo-10 regardless.

    Called from run_sweep when sweep_name='graph'. Returns the same
    {report, result_json, run_dir} shape as the generic sweep path.
    """
    import os
    from datetime import datetime, timezone

    rounds_out = []
    accumulated_overrides = dict(GRAPH_BASE_OVERRIDES)
    last_points = []

    for round_def in GRAPH_ROUNDS:
        knob_name = round_def["knob"]
        values = round_def["values"][:2] if synthetic else round_def["values"]

        # Build grid: one point per value, all pinned with accumulated_overrides
        grid = [
            {**accumulated_overrides, knob_name: v}
            for v in values
        ]
        overrides_jsons = [json.dumps(p) for p in grid]
        point_results = list(run_point.map(overrides_jsons))
        points = [json.loads(pr) for pr in point_results]
        last_points = points

        # Winner = highest MRR in this round
        winner = max(points, key=lambda p: p["metrics"]["mrr"])
        winning_value = winner["overrides"][knob_name]
        winning_mrr = winner["metrics"]["mrr"]

        rounds_out.append({
            "name": round_def["name"],
            "knob": knob_name,
            "values": values,
            "points": points,
            "winner": {"value": winning_value, "mrr": winning_mrr},
        })

        # Pin for next round
        accumulated_overrides[knob_name] = winning_value

    # Persistence — mirrors run_sweep pattern (9.4.8 f5baae5)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-graph"
    os.makedirs(run_dir, exist_ok=True)

    payload = {
        "_schema": 1,
        "sweep_name": "graph",
        "synthetic": synthetic,
        "timestamp": ts,
        "corpus_len": 10,
        "qa_count": last_points[0]["runCount"] if last_points else 0,
        "base_overrides": GRAPH_BASE_OVERRIDES,
        "rounds": rounds_out,
        "composite_elbow": {
            "overrides": accumulated_overrides,
            "rationale": "Coordinate descent winners across 6 rounds, each round's MRR-best value pinned into the next round's baseOverrides.",
        },
    }
    result_json_str = json.dumps(payload, indent=2)
    report = render_graph_report_stub(payload)

    with open(os.path.join(run_dir, "result.json"), "w") as f:
        f.write(result_json_str)
    with open(os.path.join(run_dir, "report.md"), "w") as f:
        f.write(report)
    volume.commit()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }


def _cartesian_product(knobs):
    """Generate cartesian product of knob value arrays."""
    if not knobs:
        return [{}]
    first, *rest = knobs
    rest_product = _cartesian_product(rest)
    result = []
    for value in first["values"]:
        for point in rest_product:
            result.append({first["name"]: value, **point})
    return result


@app.function(image=image, volumes={"/data": volume}, secrets=[env_secret], timeout=1800, memory=4096)
def run_sweep(sweep_name: str, synthetic: bool = False) -> dict:
    """Run a full parameter sweep in parallel via Modal.

    Args:
        sweep_name: 'tau', 'bm25', 'graph', or 'consolidation'.
        synthetic: If True, use a tiny 2-point grid for smoke testing.
            The corpus is always full LoCoMo-10; `synthetic` only shrinks
            the knob grid, not the data.

    Returns:
        Dict with keys:
            - report (str): rendered Markdown for the sweep.
            - result_json (str): JSON-serialized raw payload (schema v1)
              with sweep_name, timestamp, points, elbow, corpus stats.
            - run_dir (str): path inside the Modal Volume where both
              `result.json` and `report.md` were persisted.

    Dispatch: 'graph' and 'consolidation' (9.4.9) use specialized
    multi-round runners; 'tau' and 'bm25' use the generic grid path
    below.
    """
    import os
    import subprocess
    import json
    from datetime import datetime

    # 9.4.9 dispatch — multi-round sweeps run in specialized helpers
    # that manage their own persistence + rendering.
    if sweep_name == "graph":
        return run_graph_sweep(synthetic)
    if sweep_name == "consolidation":
        return run_consolidation_sweep(synthetic)

    config = SWEEP_CONFIGS[sweep_name]
    knobs = config["knobs"]
    primary_metric = config["primary_metric"]
    renderer = config["renderer"]

    # Symlink cache
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    if synthetic:
        # Tiny 2-point grid for smoke testing. Both points must populate
        # EVERY knob the renderer reads — otherwise render_tau_report's
        # p["overrides"]["TIER2_TAU_GAP"] (and equivalents) will KeyError.
        # Use spec defaults for one knob, a deviation for the other, so
        # the elbow detector has two distinguishable points per axis.
        if sweep_name == "tau":
            grid = [
                {"TIER2_TAU_CONFIDENCE": 2.0, "TIER2_TAU_GAP": 0.5},  # spec defaults
                {"TIER2_TAU_CONFIDENCE": 0.5, "TIER2_TAU_GAP": 0.5},  # low-confidence variant
            ]
        else:  # bm25
            grid = [
                {"TAG_BOOST": 2, "SUBJECT_BOOST": 2},  # spec defaults
                {"TAG_BOOST": 3, "SUBJECT_BOOST": 2},  # +tag variant
            ]
    else:
        grid = _cartesian_product(knobs)

    # Fan out to parallel containers
    overrides_jsons = [json.dumps(point) for point in grid]
    point_results = list(run_point.map(overrides_jsons))

    points = [json.loads(pr) for pr in point_results]

    elbow = _detect_elbow(points, knobs, primary_metric)

    result = {
        "name": sweep_name,
        "points": points,
        "elbow": elbow,
    }

    # Compute corpus stats (Modal containers already ran the full corpus)
    # Corpus is always the full LoCoMo-10 (_modal-point.js calls
    # loadLocomo({ offline: true }) with no maxConversations). The
    # `synthetic` flag shrinks the GRID, not the corpus — so every
    # point's metrics are over 1986 QAs regardless of synthetic mode.
    corpus_len = 10
    qa_count = points[0]["runCount"] if points else 0

    if sweep_name == "bm25":
        # Tags populated rate: compute from one seeded conversation via a small
        # helper subprocess. The Modal container has `/repo` and volume mount,
        # so we shell out to a Node one-liner.
        tags_probe = subprocess.run(
            ["node", "-e", """
                const { loadLocomo } = await import('./bench/loaders/index.js');
                const { seedConversation } = await import('./bench/harness/seeder.js');
                const { loadState } = await import('./src/core/state.js');
                const corpus = await loadLocomo({ offline: true, maxConversations: 1 });
                const seed = await seedConversation(corpus[0], { chatIdPrefix: 'tags-probe', keepBackend: true });
                const state = await loadState(seed.chatId);
                const ep = Object.values(state.entries).filter(e => e.scope === 'episodic');
                const withTags = ep.filter(e => Array.isArray(e.tags) && e.tags.length > 0).length;
                console.log(JSON.stringify({ n: ep.length, withTags, rate: ep.length > 0 ? withTags / ep.length : 0 }));
            """.strip()],
            cwd="/repo",
            capture_output=True,
            text=True,
            check=True,
        )
        tags_data = json.loads(tags_probe.stdout.strip().split("\n")[-1])
        tags_stats = {"rate": tags_data["rate"], "n": tags_data["n"]}
    else:
        tags_stats = None

    report = renderer(result, corpus_len, qa_count, tags_stats) if tags_stats else renderer(result, corpus_len, qa_count)

    # Persist raw + rendered outputs to the Modal Volume so nothing is lost
    # if the calling session drops before the markdown is received. Schema
    # version lets the reconstruction shim read older runs if we ever change
    # the payload shape.
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-{sweep_name}"
    os.makedirs(run_dir, exist_ok=True)

    payload = {
        "_schema": 1,
        "sweep_name": sweep_name,
        "synthetic": synthetic,
        "timestamp": ts,
        "corpus_len": corpus_len,
        "qa_count": qa_count,
        "tags_stats": tags_stats,
        "result": result,
    }
    result_json_str = json.dumps(payload, indent=2)

    with open(os.path.join(run_dir, "result.json"), "w") as f:
        f.write(result_json_str)
    with open(os.path.join(run_dir, "report.md"), "w") as f:
        f.write(report)

    # commit() makes writes visible to subsequent containers and to
    # `modal volume ls / get` on the host.
    volume.commit()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }


@app.local_entrypoint()
def main(
    mode: str = "hello",
    overrides_json: str = "{}",
    sweep_name: str = "tau",
    synthetic: bool = False,
    local_out: str = "",
):
    """Dispatch entrypoint for Modal bench functions.

    Usage:
        modal run bench/modal/sweep_app.py
            → runs hello() and prints nodeVersion + volume mount check

        modal run bench/modal/sweep_app.py --mode run-point --overrides-json '{}'
            → runs run_point() with empty overrides

        modal run bench/modal/sweep_app.py --mode run-point --overrides-json '{"TIER2_TAU_CONFIDENCE": 0.5}'
            → runs run_point() with one override

        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name tau --synthetic
            → runs run_sweep() with synthetic corpus (2 points)

        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name tau \\
                --local-out docs/bench/runs
            → also mirrors report.md + result.json to the host dir
              (independent of the Modal Volume copy at /data/runs/<ts>-<sweep>/)
    """
    if mode == "hello":
        print(json.dumps(hello.remote(), indent=2))
    elif mode == "run-point":
        print(run_point.remote(overrides_json))
    elif mode == "run-sweep":
        sweep_out = run_sweep.remote(sweep_name, synthetic)
        report = sweep_out["report"]
        result_json_str = sweep_out["result_json"]
        run_dir = sweep_out["run_dir"]
        print(report)
        print(f"\n<!-- saved to Modal Volume: {run_dir} -->", file=__import__("sys").stderr)
        if local_out:
            import os as _os
            from pathlib import Path as _Path
            out = _Path(local_out).expanduser()
            out.mkdir(parents=True, exist_ok=True)
            stem = _os.path.basename(run_dir)  # e.g. 2026-04-22T15-23-45Z-tau
            (out / f"{stem}.md").write_text(report)
            (out / f"{stem}.json").write_text(result_json_str)
            print(f"<!-- mirrored to host: {out / stem}.{{md,json}} -->", file=__import__("sys").stderr)
    else:
        print(f"Unknown mode: {mode!r}. Expected 'hello', 'run-point', or 'run-sweep'.")
