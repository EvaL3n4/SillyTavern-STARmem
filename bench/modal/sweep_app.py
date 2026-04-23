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
    timeout=1500,
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
        # Commit volume even on error — partial cache writes from live
        # extractions are still valuable (survive to next run) even if
        # this point crashed before the Node subprocess completed
        # metrics computation. Guard against commit failures so an
        # error return isn't masked by a commit exception.
        try:
            volume.commit()
        except Exception:
            pass
        return _json.dumps({
            "error": "node subprocess failed",
            "returncode": result.returncode,
            "stderr": result.stderr,
            "stdout_tail": result.stdout[-2000:] if result.stdout else "",
            "diagnostics": diag,
        }, indent=2)
    # 9.5 (2026-04-22): commit volume per-point so live extractions
    # written to /data/extractions survive container timeouts.
    # Previously commit only happened at run_sweep exit, which meant
    # a run_point timeout (e.g. 600s cap on BATCH_SIZE round with
    # ~500 live Nano-GPT calls @ ~1.3s/call) discarded every cached
    # extraction. Fix: per-point commit so a re-run picks up the
    # warm partial cache from the timed-out run. Minimal cost —
    # commit is fast when there are no pending writes.
    volume.commit()
    return result.stdout.strip()


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=600,
    memory=4096,
)
def run_baseline_point(retriever_id: str) -> str:
    """Run one baseline retriever over the full corpus.

    Args:
        retriever_id: one of BASELINE_IDS ("ladder", "bm25only", "recency", "random").

    Returns:
        JSON string with { retrieverId, metrics, latencyMs, runCount, wallMs, envSnapshot }.
    """
    import os
    import subprocess

    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    env = os.environ.copy()
    env["STARMEM_RETRIEVER_ID"] = retriever_id

    result = subprocess.run(
        ["node", "bench/baselines/_modal-point.js"],
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
            "retrieverId": retriever_id,
            "returncode": result.returncode,
            "stderr": result.stderr,
            "stdout_tail": result.stdout[-2000:] if result.stdout else "",
        }, indent=2)
    return result.stdout.strip()


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=600,
    memory=4096,
)
def run_batchsize_point(conv_idx: int, batch_size: int) -> str:
    """Run one (conversation, BATCH_SIZE) cell.

    Args:
        conv_idx: 0-indexed conversation slot in LoCoMo-10.
        batch_size: BATCH_SIZE override to apply.

    Returns:
        JSON string with { convIdx, batchSize, metrics, consolidationStats,
        latencyMs, wallMs }.
    """
    import os
    import subprocess

    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    env = os.environ.copy()
    env["STARMEM_CONV_IDX"] = str(conv_idx)
    env["STARMEM_BATCH_SIZE"] = str(batch_size)

    result = subprocess.run(
        ["node", "bench/sweeps/_modal-batchsize-point.js"],
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
            "convIdx": conv_idx,
            "batchSize": batch_size,
            "returncode": result.returncode,
            "stderr": result.stderr,
            "stdout_tail": result.stdout[-2000:] if result.stdout else "",
        }, indent=2)
    return result.stdout.strip()


BASELINE_IDS = ["ladder", "bm25only", "recency", "random"]
BATCHSIZE_VALUES = [3, 5, 7, 10, 15]
BATCHSIZE_CONV_INDICES = [0, 1, 2, 3, 4]


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1800,
    memory=4096,
)
def run_baselines() -> dict:
    """Fan out baseline retrievers to parallel containers.

    Returns:
        Dict with keys:
            - report (str): rendered Markdown comparison table.
            - result_json (str): JSON-serialized payload (all 4 baselines' metrics).
            - run_dir (str): path inside the Modal Volume.
    """
    import json
    import os
    from datetime import datetime

    point_results = list(run_baseline_point.map(BASELINE_IDS))
    points = [json.loads(pr) for pr in point_results]

    ts = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-baselines"
    os.makedirs(run_dir, exist_ok=True)

    result_payload = {
        "name": "baselines",
        "timestamp": ts,
        "points": points,
    }
    result_json_str = json.dumps(result_payload, indent=2)
    with open(f"{run_dir}/result.json", "w") as f:
        f.write(result_json_str)

    report = render_baselines_report(result_payload)
    with open(f"{run_dir}/report.md", "w") as f:
        f.write(report)

    volume.commit()

    return {
        "report": report,
        "result_json": result_json_str,
        "run_dir": run_dir,
    }


def render_baselines_report(payload):
    """Render the four-retriever comparison as Markdown.

    Columns: retriever, MRR, Coverage, R@5, R@10, latency.
    Coverage comes from Task 4; if unavailable, emit '—'.
    """
    lines = []
    lines.append(f"# Baselines comparison — {payload['timestamp']}")
    lines.append("")
    lines.append("| Retriever | MRR | Coverage | R@5 | R@10 | Latency (ms) |")
    lines.append("|---|---|---|---|---|---|")
    for pt in payload["points"]:
        rid = pt["retrieverId"]
        m = pt.get("metrics", {})
        mrr_v = m.get("mrr", float("nan"))
        cov = m.get("coverage", None)
        r5 = m.get("recallAtK", {}).get("5", float("nan"))
        r10 = m.get("recallAtK", {}).get("10", float("nan"))
        lat = pt.get("latencyMs", float("nan"))
        cov_cell = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        lines.append(
            f"| `{rid}` | {mrr_v:.4f} | {cov_cell} | {r5:.4f} | {r10:.4f} | {lat:.1f} |"
        )
    lines.append("")
    # Structural invariant
    ladder = next((p for p in payload["points"] if p["retrieverId"] == "ladder"), None)
    bm25 = next((p for p in payload["points"] if p["retrieverId"] == "bm25only"), None)
    if ladder and bm25:
        delta = ladder["metrics"]["mrr"] - bm25["metrics"]["mrr"]
        verdict = "PASS" if delta >= -0.02 else "FAIL"
        lines.append(f"**Structural invariant (ladder ≥ bm25only − 0.02):** ladder_mrr − bm25only_mrr = {delta:+.4f} → **{verdict}**")
    return "\n".join(lines)


ABS_DELTA_FLOOR = 0.005
"""Below this absolute Δmetric/Δknob on every point, the axis is considered
flat and no elbow is proposed. Field-validated against STARmem 9.5 false
positives — see docs/plans/phase-11-infrastructure-hardening.md Task 1."""


def _detect_elbow(points, knobs, primary_metric):
    """Python port of _driver.js detectElbow.

    Args:
        points: list of dicts with 'overrides' and 'metrics'.
        knobs: list of {name, values} dicts.
        primary_metric: string key into METRIC_ACCESSORS.

    Returns:
        dict with 'overrides' and 'rationale'.

    Phase 11 Task 1: zero-axis-Δ guard. When the primary axis has no
    meaningful variation (maxΔ/Δknob < ABS_DELTA_FLOOR across the whole
    point set), return spec defaults with a "held at spec" rationale
    instead of the sort-first-corner artifact. Field-validated against
    3 false positives in 9.5 (TIER2_TAU_CONFIDENCE, bm25 TAG×SUBJECT
    grid, relw axis).
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
        # No slice surfaced an elbow. Two sub-cases distinguished by the
        # axis-wide maxΔ/Δknob:
        #   (1) Axis is flat (maxΔ < ABS_DELTA_FLOOR) — honest answer is
        #       "held at spec defaults, knob flat on this corpus."
        #   (2) Real data but no elbow shape — keep the pre-Phase-11
        #       fallback to highest-metric for backward compatibility.
        # Default overrides = first value of every knob. Convention
        # verified at Phase 11 plan-time for tau/bm25/hops/relw: each
        # SWEEP_CONFIGS entry lists the spec default first in `values`.
        default_overrides = {k["name"]: k["values"][0] for k in knobs}
        sorted_all = sorted(points, key=lambda p: p["overrides"][primary_knob["name"]])
        all_metrics = [accessor(p["metrics"]) for p in sorted_all]
        all_values = [p["overrides"][primary_knob["name"]] for p in sorted_all]
        all_deltas = []
        for i in range(len(all_metrics) - 1):
            dk = all_values[i + 1] - all_values[i]
            all_deltas.append(0 if dk == 0 else (all_metrics[i + 1] - all_metrics[i]) / dk)
        axis_max_delta = max((abs(d) for d in all_deltas), default=0.0)
        best = max(points, key=lambda p: accessor(p["metrics"]))
        best_metric = accessor(best["metrics"])
        if axis_max_delta < ABS_DELTA_FLOOR:
            return {
                "overrides": default_overrides,
                "rationale": (
                    f"Axis flat (maxΔ/Δknob = {axis_max_delta:.6f} ≤ {ABS_DELTA_FLOOR}); "
                    f"held at spec on {primary_knob['name']}. Highest observed "
                    f"{primary_metric} = {best_metric:.4f}."
                ),
            }
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

    # Zero-axis-Δ guard (Phase 11 Task 1). If the axis has no meaningful
    # variation, the sort-first corner is not an elbow — it's an artifact
    # of the ratio=0.1×max_delta threshold collapsing to ~1e-12. Return
    # None so _detect_elbow's "no elbows found" branch surfaces a
    # flat-axis rationale instead of a false amendment.
    if max_delta < ABS_DELTA_FLOOR:
        return None

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


def _should_amend(baseline_metrics, candidate_metrics, min_mrr_delta=0.02, max_coverage_drop=0.05):
    """Python mirror of bench/render/amendment-rule.js::shouldAmend.

    Returns dict with keys {amend: bool, reason: str, mrr_delta: float, coverage_delta: float}.
    Catches subset-selection bias: MRR may climb because coverage falls (smaller answerable
    query subset), not because retrieval improved. Gate: ΔMRR ≥ 0.02 AND Δcoverage ≥ −5pp.
    """
    import math
    mrr_delta = candidate_metrics.get("mrr", float("nan")) - baseline_metrics.get("mrr", float("nan"))
    cov_delta = candidate_metrics.get("coverage", float("nan")) - baseline_metrics.get("coverage", float("nan"))

    if math.isnan(mrr_delta) or math.isnan(cov_delta):
        return {
            "amend": False,
            "reason": "Cannot amend: NaN in baseline or candidate metrics.",
            "mrr_delta": mrr_delta,
            "coverage_delta": cov_delta,
        }
    if mrr_delta < min_mrr_delta:
        return {
            "amend": False,
            "reason": f"ΔMRR = {mrr_delta:+.4f} < {min_mrr_delta} (below amendment threshold).",
            "mrr_delta": mrr_delta,
            "coverage_delta": cov_delta,
        }
    if cov_delta < -max_coverage_drop:
        return {
            "amend": False,
            "reason": f"ΔMRR = {mrr_delta:+.4f} ≥ {min_mrr_delta}, but coverage drops {-cov_delta * 100:.1f}pp > {max_coverage_drop * 100:.0f}pp allowed (subset-selection bias suspected).",
            "mrr_delta": mrr_delta,
            "coverage_delta": cov_delta,
        }
    return {
        "amend": True,
        "reason": f"ΔMRR = {mrr_delta:+.4f} ≥ {min_mrr_delta} and Δcoverage = {cov_delta * 100:+.1f}pp ≥ −{max_coverage_drop * 100:.0f}pp.",
        "mrr_delta": mrr_delta,
        "coverage_delta": cov_delta,
    }


def render_tau_report(result, corpus_len, qa_count):
    """Port of tau.js renderReport to Python."""
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    primary_metric = "recallAt5"

    header = "| TIER2_TAU_CONFIDENCE | TIER2_TAU_GAP | recallAt5 | precisionAt3 | mrr | coverage | p50 | p95 |"
    separator = "|---|---|---|---|---|---|---|---|---|"
    rows = []
    for p in result["points"]:
        tc = p["overrides"]["TIER2_TAU_CONFIDENCE"]
        tg = p["overrides"]["TIER2_TAU_GAP"]
        r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
        p3 = f"{p['metrics']['precisionAtK']['3']:.4f}"
        mrr = f"{p['metrics']['mrr']:.4f}"
        cov = p["metrics"].get("coverage")
        cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {tc} | {tg} | {r5} | {p3} | {mrr} | {cov_s} | {p50} | {p95} |")

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

    # Amendment verdict (Phase 11 Task 4)
    baseline_pt = result["points"][0] if result["points"] else None
    candidate_pt = None
    if baseline_pt and result["elbow"].get("overrides"):
        candidate_pt = next(
            (p for p in result["points"]
             if all(p["overrides"].get(k) == v for k, v in result["elbow"]["overrides"].items())),
            None,
        )
    if baseline_pt and candidate_pt and candidate_pt is not baseline_pt:
        verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
        amendment_verdict_block = (
            f"\n### Amendment verdict\n\n"
            f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}"
        )
    else:
        amendment_verdict_block = "\n### Amendment verdict\n\nNo distinct candidate point found — held at spec."

    first_point = result["points"][0] if result["points"] else None
    env_block = (
        "```json\n" + json.dumps(first_point["metrics"], indent=2) + "\n```"
        if first_point else "No points recorded."
    )

    rows_joined = "\n".join(rows)
    heatmap_rows_joined = "\n".join(heatmap_rows)

    report = f"""# τ sweep — {today}

|**Corpus:** {corpus_len} conversations, {qa_count} QA items
|**Primary metric:** {primary_metric}

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

{amendment_section}{amendment_verdict_block}

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

    header = "| TAG_BOOST | SUBJECT_BOOST | recallAt5 | precisionAt3 | mrr | coverage | p50 | p95 |"
    separator = "|---|---|---|---|---|---|---|---|---|"
    rows = []
    for p in result["points"]:
        tb = p["overrides"]["TAG_BOOST"]
        sb = p["overrides"]["SUBJECT_BOOST"]
        r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
        p3 = f"{p['metrics']['precisionAtK']['3']:.4f}"
        mrr = f"{p['metrics']['mrr']:.4f}"
        cov = p["metrics"].get("coverage")
        cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {tb} | {sb} | {r5} | {p3} | {mrr} | {cov_s} | {p50} | {p95} |")

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

    # Amendment verdict (Phase 11 Task 4)
    baseline_pt = result["points"][0] if result["points"] else None
    candidate_pt = None
    if baseline_pt and result["elbow"].get("overrides"):
        candidate_pt = next(
            (p for p in result["points"]
             if all(p["overrides"].get(k) == v for k, v in result["elbow"]["overrides"].items())),
            None,
        )
    if baseline_pt and candidate_pt and candidate_pt is not baseline_pt:
        verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
        amendment_verdict_block = (
            f"\n### Amendment verdict\n\n"
            f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}"
        )
    else:
        amendment_verdict_block = "\n### Amendment verdict\n\nNo distinct candidate point found — held at spec."

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

{amendment_section}{amendment_verdict_block}

## envSnapshot

{env_block}
"""
    return report


def render_single_axis_report(result, corpus_len, qa_count):
    """Generic single-knob sweep renderer.

    Used by the 9.5 `hops` and `relw` sweeps, both of which vary a single
    graph-tier knob with TIER2_TAU_GAP=10 pinned in every grid point. Emits
    a compact table (axis value → primary metric + secondary metrics) plus
    a per-row ΔMRR column vs the sweep's own baseline (point with the
    smallest primary-knob value). No heatmap — single axis.
    """
    import json
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    points = result["points"]
    if not points:
        return f"# {result['name']} sweep — {today}\n\nNo points returned.\n"

    # Identify the swept knob (exclude inlined baseOverrides like TIER2_TAU_GAP)
    overrides0 = points[0]["overrides"]
    # The swept knob is the one with distinct values across points; baseOverrides
    # are identical across all points.
    swept_knob = None
    for k in overrides0:
        distinct = {p["overrides"].get(k) for p in points}
        if len(distinct) > 1:
            swept_knob = k
            break
    if swept_knob is None:
        # Degenerate (1-point grid) — fall back to first non-baseOverride key
        swept_knob = next(iter(overrides0))

    sorted_pts = sorted(points, key=lambda p: p["overrides"][swept_knob])
    baseline_mrr = sorted_pts[0]["metrics"]["mrr"]

    header = f"| {swept_knob} | n_scored | recallAt5 | mrr | coverage | ΔMRR vs min | p50 | p95 |"
    sep = "|---|---|---|---|---|---|---|---|---|"
    rows = []
    for p in sorted_pts:
        v = p["overrides"][swept_knob]
        n_scored = p["metrics"].get("n_scored", "-")
        r5 = f"{p['metrics']['recallAtK']['5']:.4f}"
        mrr = p["metrics"]["mrr"]
        cov = p["metrics"].get("coverage")
        cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
        delta = mrr - baseline_mrr
        mrr_s = f"{mrr:.4f}"
        delta_s = f"{delta:+.4f}"
        p50 = f"{p['latencyMs']['p50']:.2f}"
        p95 = f"{p['latencyMs']['p95']:.2f}"
        rows.append(f"| {v} | {n_scored} | {r5} | {mrr_s} | {cov_s} | {delta_s} | {p50} | {p95} |")

    elbow = result.get("elbow", {})
    elbow_overrides = elbow.get("overrides", {})
    elbow_rationale = elbow.get("rationale", "—")
    base_overrides = {k: v for k, v in overrides0.items() if k != swept_knob}
    base_block = (
        f"**Base overrides (inlined into every point):** `{json.dumps(base_overrides)}`\n"
        if base_overrides else ""
    )

    # Amendment verdict (Phase 11 Task 4)
    baseline_pt = sorted_pts[0] if sorted_pts else None
    candidate_pt = None
    if baseline_pt and elbow_overrides:
        candidate_pt = next(
            (p for p in points
             if all(p["overrides"].get(k) == v for k, v in elbow_overrides.items())),
            None,
        )
    if baseline_pt and candidate_pt and candidate_pt is not baseline_pt:
        verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
        amendment_verdict_block = (
            f"\n### Amendment verdict\n\n"
            f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}"
        )
    else:
        amendment_verdict_block = "\n### Amendment verdict\n\nNo distinct candidate point found — held at spec."

    report = f"""# {result["name"]} sweep — {today}

**Corpus:** LoCoMo-{corpus_len} ({qa_count} QA items, live extraction)
**Swept:** {swept_knob}
{base_block}
## Results

{header}
{sep}
{chr(10).join(rows)}

## Elbow

**Recommended:** `{json.dumps(elbow_overrides)}`
**Rationale:** {elbow_rationale}{amendment_verdict_block}
"""
    return report


SWEEP_CONFIGS = {
    "tau": {
        # 9.5: restored to the Phase 9 Task 4 full grid (48 points) so the
        # renderer's heatmap is populated. 9.4.8 had trimmed this to a
        # 4-knob validation config after amending gap=10; 9.5 re-sweeps
        # under live extraction to detect whether the gap=10 plateau holds
        # or the elbow shifts on Gemma-extracted facts.
        "knobs": [
            {"name": "TIER2_TAU_CONFIDENCE", "values": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]},
            {"name": "TIER2_TAU_GAP",        "values": [0.1, 0.3, 0.5, 1.0, 3.0, 10.0]},
        ],
        "primary_metric": "recallAt5",
        "renderer": render_tau_report,
    },
    "bm25": {
        # 9.5: restored from 9.4.8's 2-knob validation config to the full
        # 4×4 grid so render_bm25_report emits a heatmap.
        "knobs": [
            {"name": "TAG_BOOST",     "values": [1, 2, 3, 4]},
            {"name": "SUBJECT_BOOST", "values": [1, 2, 3, 4]},
        ],
        "primary_metric": "mrr",
        "renderer": render_bm25_report,
    },
    "hops": {
        # 9.5: TIER3_MAX_HOPS sweep (Phase 9 left this knob uncovered).
        # Every point runs with TIER2_TAU_GAP=10 baseOverride so queries
        # reach Tier 3 (same invariant as GRAPH_ROUNDS). Inline the
        # baseOverride into each grid point because run_sweep doesn't
        # honor a config["base_overrides"] key — it hands `grid` directly
        # to run_point.map.
        "knobs": [
            {"name": "TIER3_MAX_HOPS", "values": [1, 2, 3, 4]},
        ],
        "primary_metric": "mrr",
        "renderer": render_single_axis_report,
    },
    "relw": {
        # 9.5: EXPLICIT_RELATION_WEIGHT sweep (Phase 9 left this knob
        # uncovered). Same gap=10 inlining as hops.
        "knobs": [
            {"name": "EXPLICIT_RELATION_WEIGHT", "values": [0.5, 1.0, 1.5, 2.0, 3.0]},
        ],
        "primary_metric": "mrr",
        "renderer": render_single_axis_report,
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
    """9.4.9 — full graph sweep renderer.

    Replaces the minimal stub from Task 2. Ports bench/sweeps/graph.js's
    renderReport() structure, with one intentional deviation: the JS
    reference used a synthesized Tier-2-only baseline row (via a
    TIER2_TAU_CONFIDENCE=0.01 forced-exit probe) because 9.4.6 measured
    the ladder as structurally broken and needed a non-Tier-3 reference
    point. Post-9.4.8 the baseline is TIER2_TAU_GAP=10 alone
    (MRR 0.8077 from baseline.json), so the Python renderer compares
    against that directly — no separate baseline probe required.

    Name kept as `_stub` for backward compat with existing call sites;
    rename to `render_graph_report` is a trivial follow-up.
    """
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    rounds = payload["rounds"]
    base = payload["base_overrides"]
    composite = payload["composite_elbow"]["overrides"]

    # Gap=10-alone baseline MRR (from docs/bench/baseline.json measured at
    # commit 10f7372, validation sweep confirmed at cb30323).
    BASELINE_GAP10_MRR = 0.8077
    # Post-9.4.8 baseline coverage: gap=10 produces n_scored=1277 on
    # LoCoMo-10, = 64.3%. This is DIFFERENT from baseline.json's
    # "~71% of QAs" which was measured pre-amendment at gap=0.5.
    # The coverage warning fires on deviations >5pp from this.
    BASELINE_COVERAGE_PCT = 64.3
    AMENDMENT_THRESHOLD = 0.02  # per plan decision 5
    COVERAGE_FLOOR_DELTA_PCT = 5.0

    # Per-round sections
    round_sections = []
    for idx, r in enumerate(rounds):
        knob = r["knob"]
        # Build base-overrides string reflecting previous rounds' winners.
        prev_overrides = dict(base)
        for prev_idx in range(idx):
            prev = rounds[prev_idx]
            prev_overrides[prev["knob"]] = prev["winner"]["value"]

        header = f"| {knob} | n_scored | recallAt5 | precisionAt3 | mrr | coverage | p50 | p95 | ΔMRR vs gap=10 |"
        separator = "|---|---|---|---|---|---|---|---|---|---|"
        rows = []
        has_coverage_drop = False
        for p in r["points"]:
            v = p["overrides"][knob]
            m = p["metrics"]
            n_scored = m.get("n_scored", "—")
            r5 = f"{m['recallAtK']['5']:.4f}"
            p3 = f"{m['precisionAtK']['3']:.4f}"
            mrr = m["mrr"]
            mrr_str = f"{mrr:.4f}"
            cov = m.get("coverage")
            cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
            lift = mrr - BASELINE_GAP10_MRR
            lift_str = f"{lift:+.4f}"
            p50 = f"{p['latencyMs']['p50']:.2f}"
            p95 = f"{p['latencyMs']['p95']:.2f}"
            # Coverage: flag if deviation > COVERAGE_FLOOR_DELTA_PCT from
            # post-9.4.8 baseline. Below BASELINE - 5pp means the knob
            # traded coverage for precision, and the MRR is computed
            # over a smaller, possibly-easier subset.
            coverage_pct = (cov * 100) if isinstance(cov, (int, float)) else None
            n_scored_cell = f"{n_scored}"
            if coverage_pct is not None and abs(coverage_pct - BASELINE_COVERAGE_PCT) > COVERAGE_FLOOR_DELTA_PCT:
                n_scored_cell = f"⚠️ {n_scored}"
                has_coverage_drop = True
            # Bold the winner row
            is_winner = v == r["winner"]["value"]
            v_cell = f"**{v}**" if is_winner else str(v)
            rows.append(
                f"| {v_cell} | {n_scored_cell} | {r5} | {p3} | "
                f"{mrr_str} | {cov_s} | {p50} | {p95} | {lift_str} |"
            )
        rows_joined = "\n".join(rows)

        winner_mrr = r["winner"]["mrr"]
        round_lift = winner_mrr - BASELINE_GAP10_MRR
        amend_flag = " **(clears amendment threshold)**" if round_lift >= AMENDMENT_THRESHOLD else ""

        coverage_warning = ""
        if has_coverage_drop:
            coverage_warning = (
                "\n\n> **⚠️ Coverage warning:** at least one point in this round deviates "
                f">{COVERAGE_FLOOR_DELTA_PCT}pp from post-9.4.8 baseline coverage "
                f"(~{BASELINE_COVERAGE_PCT:.0f}%). MRR gains may reflect subset-selection bias — "
                "the knob traded coverage for per-query precision. Verify against recall@5 on "
                "the full corpus before amending."
            )

        prev_overrides_json = json.dumps(prev_overrides)

        round_sections.append(
            f"## Round — {knob}\n\n"
            f"**Base overrides:** `{prev_overrides_json}`\n\n"
            f"{header}\n{separator}\n{rows_joined}\n\n"
            f"**Winner:** `{knob} = {r['winner']['value']}` "
            f"(mrr={winner_mrr:.4f}, ΔMRR vs gap=10 = {round_lift:+.4f})"
            f"{amend_flag}"
            f"{coverage_warning}"
        )

    rounds_joined = "\n\n".join(round_sections)

    # Composite elbow: all winners stacked.
    composite_mrr = rounds[-1]["winner"]["mrr"] if rounds else None
    composite_lift = (composite_mrr - BASELINE_GAP10_MRR) if composite_mrr is not None else 0.0
    composite_verdict = (
        f"clears amendment threshold ({AMENDMENT_THRESHOLD:.2f})"
        if composite_lift >= AMENDMENT_THRESHOLD
        else f"below amendment threshold ({AMENDMENT_THRESHOLD:.2f}) — composite is noise-level"
    )

    # Per-knob spec defaults for the amendment proposal section.
    # Source: src/core/constants.js, pre-9.4.9 defaults.
    spec_defaults = {
        "TIER3_LAMBDA_1": 1.0,
        "TIER3_LAMBDA_2": 0.3,
        "TIER3_BEAM_WIDTH": 5,
        "TIER3_SEEDS_K": 3,
        "EDGE_CAP_PER_ENTRY": 20,
        "COOCCURRENCE_WEIGHT": 0.5,
    }
    baseline_metrics = {"mrr": BASELINE_GAP10_MRR, "coverage": BASELINE_COVERAGE_PCT / 100}
    amendment_lines = []
    for r in rounds:
        knob = r["knob"]
        spec = spec_defaults.get(knob)
        measured = r["winner"]["value"]
        if spec is None:
            continue

        winner_point = next(
            (p for p in r["points"] if p["overrides"][knob] == measured),
            None,
        )
        if winner_point:
            verdict = _should_amend(baseline_metrics, winner_point["metrics"])
        else:
            verdict = {"amend": False, "reason": "Winner point not found in round."}

        if verdict["amend"]:
            amendment_lines.append(
                f"- **`{knob}`**: spec default `{spec}` → measured `{measured}` "
                f"({verdict['reason']}) — AMEND"
            )
        else:
            amendment_lines.append(
                f"- `{knob}`: spec default `{spec}` → measured `{measured}` "
                f"({verdict['reason']}) — **HOLD**"
            )
    amendment_section = "\n".join(amendment_lines) if amendment_lines else "No amendments proposed."

    composite_json = json.dumps(composite, indent=2)
    base_overrides_json = json.dumps(base)

    report = f"""# Graph sweep — {today}

**Corpus:** {payload['corpus_len']} conversations, {payload['qa_count']} QA items
**Primary metric:** mrr
**Baseline:** `TIER2_TAU_GAP=10` alone (MRR {BASELINE_GAP10_MRR:.4f}, docs/bench/baseline.json::headlineMetrics.ladder post-9.4.8)
**Base overrides on every point:** `{base_overrides_json}`
**Rounds:** {len(rounds)} coordinate-descent; each round's winner pins into the next.

{rounds_joined}

## Composite elbow

All round winners stacked as a single override set:

```json
{composite_json}
```

**Composite ΔMRR vs gap=10 baseline:** {composite_lift:+.4f} — {composite_verdict}.

## Spec amendment proposal

Per-round amendments (amendment threshold = ΔMRR ≥ {AMENDMENT_THRESHOLD:.2f}):

{amendment_section}

Each AMEND knob ships as a separate commit per plan decision 5 —
src/core/constants.js default + docs/specs/2026-04-20-starmem-v2-design.md
§5.1 tuning callout + docs/bench/baseline.json::tuned entry update.

## Notes

- The baseline is gap=10 alone (not spec-default gap=0.5). Graph knobs
  are only meaningful when Tier 2 gating is disabled, and 9.4.8 showed
  that's the current production default. ΔMRR measurements here are
  therefore on top of 9.4.8's +0.0625 MRR amendment.
- Winner rows are **bolded** in each round's table. The elbow is the
  MRR-best point in the round, not necessarily the middle of the range.
"""
    return report


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


# 9.4.9 — consolidation sweep.
# Two independent single-axis rounds. Each is interpreted standalone
# because the knobs affect orthogonal parts of the pipeline (dedup
# Jaccard gates merge decisions; batch_size gates per-call drain
# cardinality). No coordinate descent across rounds.
#
# Branch C pre-registered: 9.4.6 retro found rule-based seeder
# under-stresses dedup (updateRate 4.4% → 0.7% across thresholds,
# retrieval MRR flat to 4 decimals). If 9.4.9 reproduces flatness
# (MRR range <0.005 across all points in a round), the round is
# flagged flat and tuning defers to 9.5 live extraction.
CONSOLIDATION_ROUNDS = [
    {"name": "dedup",       "knob": "DEDUP_JACCARD_THRESHOLD", "values": [0.5, 0.6, 0.7, 0.8, 0.9]},
    # 9.5 (2026-04-22): BATCH_SIZE round dropped again — Branch D fired
    # twice. First attempt at run_point timeout=600s hit FunctionTimeoutError
    # after ~470 live Nano-GPT calls; raised to 1500s, hit it again after
    # ~1200+ calls. One run_point (one BATCH_SIZE grid value) materializes
    # ~94 conversations × live batched extraction at ~1.3s/call, which
    # exceeds reasonable per-point container budgets. The 9.4.9 retro
    # budget estimate ("~20% miss rate") was wrong by ~10× — changing
    # BATCH_SIZE invalidates 100% of the extraction cache for that seed
    # pass, not 20%.
    #
    # Deferred to Phase 11 for budget-aware redesign: mid-subprocess
    # periodic volume.commit() (threading, commit every 60s so SIGKILL
    # loses ≤1 min), or split by conversation count so each Modal call
    # is bounded, or use a cheaper model for the stress test.
    # Per sweep-cache-invalidation-audit's Branch D: "Do not chase a
    # timing-out sweep."
    # {"name": "batch_size", "knob": "BATCH_SIZE", "values": [8, 16, 24, 32, 48]},
]

# Threshold for Branch C "flat surface" detection. Matches the ΔMRR
# noise floor measured on LoCoMo in 9.4.6. Rounds with MRR range
# below this threshold defer tuning to 9.5.
CONSOLIDATION_FLAT_MRR_THRESHOLD = 0.005


def render_consolidation_report_stub(payload):
    """9.4.9 — full consolidation sweep renderer.

    Replaces the Task 3 stub. Per-round tables surface aggStats counters
    (added/updated/drained/updateRate/dedupHitRate) alongside retrieval
    metrics. Per-round recommendation follows the Phase 6 retro band
    rule (target updateRate ∈ [0.2, 0.4], closest to 0.3).

    Hardened amendment criteria (9.4.9 Task 5b preflight — coverage bias
    finding on graph sweep):
      - ΔMRR ≥ 0.02 absolute vs spec default, AND
      - Coverage (n_scored / n_total) stays within 5 percentage points
        of the baseline coverage (~71% on post-9.4.7 LoCoMo)

    Without the coverage floor, a knob that narrows retrieval to only
    the easy subset would produce headline MRR gains that don't reflect
    real improvement — same shape as the seeds_k=1 coverage-bias finding
    in the graph sweep.

    Branch C fires when MRR range < CONSOLIDATION_FLAT_MRR_THRESHOLD
    across a round's points — per the 9.4.6 finding that rule-based
    seeder under-stresses dedup. Flat rounds defer to 9.5.

    Name kept as `_stub` for backward compat.
    """
    from datetime import datetime
    today = datetime.now().isoformat()[:10]
    rounds = payload["rounds"]

    # Baseline MRR for ΔMRR comparisons (gap=10 alone, consistent with
    # the graph renderer). Consolidation runs offline — knobs affect
    # storage, not retrieval directly — but we still compare against
    # the same retrieval baseline.
    BASELINE_GAP10_MRR = 0.8077
    BASELINE_COVERAGE_PCT = 64.3  # post-9.4.8 baseline — see graph renderer for rationale
    AMENDMENT_THRESHOLD = 0.02
    COVERAGE_FLOOR_DELTA_PCT = 5.0  # coverage must stay within 5pp of baseline

    round_sections = []
    for r in rounds:
        knob = r["knob"]
        header = (
            f"| {knob} | added | updated | drained | updateRate | dedupHitRate | "
            f"n_scored | recallAt5 | mrr | coverage | ΔMRR vs gap=10 | p50 | p95 |"
        )
        separator = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
        rows = []
        has_coverage_drop = False
        for p in r["points"]:
            v = p["overrides"][knob]
            agg = p.get("aggStats") or {}
            added = agg.get("added", "—")
            updated = agg.get("updated", "—")
            drained = agg.get("drained", "—")
            ur_raw = agg.get("updateRate")
            dhr_raw = agg.get("dedupHitRate")
            ur = f"{ur_raw:.4f}" if ur_raw is not None else "—"
            dhr = f"{dhr_raw:.4f}" if dhr_raw is not None else "—"
            m = p["metrics"]
            n_scored = m.get("n_scored", "—")
            r5 = f"{m['recallAtK']['5']:.4f}"
            mrr = m["mrr"]
            mrr_str = f"{mrr:.4f}"
            cov = m.get("coverage")
            cov_s = f"{cov:.4f}" if isinstance(cov, (int, float)) else "—"
            lift = mrr - BASELINE_GAP10_MRR
            lift_str = f"{lift:+.4f}"
            p50 = f"{p['latencyMs']['p50']:.2f}"
            p95 = f"{p['latencyMs']['p95']:.2f}"

            coverage_pct = (cov * 100) if isinstance(cov, (int, float)) else None
            n_scored_cell = f"{n_scored}"
            if coverage_pct is not None and abs(coverage_pct - BASELINE_COVERAGE_PCT) > COVERAGE_FLOOR_DELTA_PCT:
                n_scored_cell = f"⚠️ {n_scored}"
                has_coverage_drop = True

            # Bold the winner / band-rule-best row
            is_winner = (not r["elbow"]["flat"]) and v == r["elbow"]["value"]
            v_cell = f"**{v}**" if is_winner else str(v)

            rows.append(
                f"| {v_cell} | {added} | {updated} | {drained} | {ur} | {dhr} | "
                f"{n_scored_cell} | {r5} | {mrr_str} | {cov_s} | {lift_str} | {p50} | {p95} |"
            )
        rows_joined = "\n".join(rows)

        # Branch + band-rule recommendation
        if r["elbow"]["flat"]:
            recommendation = (
                f"**Branch C fires** — MRR range {r['mrr_range']:.4f} "
                f"< {CONSOLIDATION_FLAT_MRR_THRESHOLD}. Knob inert on this "
                f"corpus with rule-based extractor. Defer tuning to "
                f"sub-phase 9.5 (live extraction regenerates cache on "
                f"demand and should exercise realistic dedup pressure)."
            )
        else:
            # Find best point by band rule: prefer updateRate ∈ [0.2, 0.4]
            # closest to 0.3, tie-break by highest MRR.
            def band_distance(p):
                ur = (p.get("aggStats") or {}).get("updateRate")
                return abs(ur - 0.3) if ur is not None else float("inf")
            best_band = min(r["points"], key=band_distance)
            best_ur = (best_band.get("aggStats") or {}).get("updateRate")
            best_mrr = best_band["metrics"]["mrr"]
            best_val = best_band["overrides"][knob]
            mrr_best = max(r["points"], key=lambda p: p["metrics"]["mrr"])

            # Hardened amendment check via _should_amend (Phase 11 Task 4)
            winner_point = next(
                (p for p in r["points"] if p["overrides"][knob] == r["elbow"]["value"]),
                None,
            )
            baseline_metrics = {"mrr": BASELINE_GAP10_MRR, "coverage": BASELINE_COVERAGE_PCT / 100}
            if winner_point:
                verdict = _should_amend(baseline_metrics, winner_point["metrics"])
            else:
                verdict = {"amend": False, "reason": "Winner point not found in round."}

            best_ur_str = f"{best_ur:.4f}" if best_ur is not None else "n/a"
            recommendation = (
                f"**Band-rule best:** `{knob} = {best_val}` "
                f"(updateRate={best_ur_str}, closest to target 0.3; MRR={best_mrr:.4f})\n\n"
                f"**MRR-best:** `{knob} = {mrr_best['overrides'][knob]}` "
                f"(MRR={mrr_best['metrics']['mrr']:.4f})\n\n"
                f"**Amendment verdict:** {'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}"
            )

        coverage_warning = ""
        if has_coverage_drop:
            coverage_warning = (
                "\n\n> **⚠️ Coverage warning:** at least one point in this round "
                f"deviates >{COVERAGE_FLOOR_DELTA_PCT}pp from baseline coverage "
                f"(~{BASELINE_COVERAGE_PCT:.0f}%). Consolidation knobs shouldn't "
                "affect retrieval coverage — investigate whether the override "
                "is interacting with the ladder unexpectedly."
            )

        round_sections.append(
            f"## Round — {knob}\n\n**Swept knob:** `{knob}`\n\n"
            f"{header}\n{separator}\n{rows_joined}\n\n{recommendation}{coverage_warning}"
        )

    rounds_joined = "\n\n".join(round_sections)

    report = f"""# Consolidation sweep — {today}

**Corpus:** {payload['corpus_len']} conversations, {payload['qa_count']} QA items
**Primary metric:** mrr (retrieval) + updateRate (consolidation-internal band rule)
**Baseline:** `TIER2_TAU_GAP=10` alone (MRR {BASELINE_GAP10_MRR:.4f}, coverage ~{BASELINE_COVERAGE_PCT:.0f}%)
**Rounds:** {len(rounds)} independent single-axis sweeps

**Amendment criteria (9.4.9 hardened):** ΔMRR ≥ {AMENDMENT_THRESHOLD:.2f} AND coverage stays within {COVERAGE_FLOOR_DELTA_PCT:.0f}pp of baseline. Either condition failing defers the amendment.

{rounds_joined}

## Notes

- Branch C is pre-registered per 9.4.6 consolidation retro finding: rule-based
  seeder may under-stress dedup/consolidation machinery. Rounds with MRR range
  <{CONSOLIDATION_FLAT_MRR_THRESHOLD} across all points flag as flat. Under
  9.5 live extraction the finding reproduced (fourth-time): Gemma 4 26B A4B
  doesn't produce enough near-duplicates on LoCoMo to stress dedup either.
  Interpretation: dedup flatness is corpus-structural (LoCoMo's fact
  distribution), not extractor-dependent.
- BATCH_SIZE round deferred to Phase 11 — Branch D fired twice on 9.5
  attempts (600s and 1500s per-point timeouts). One run_point needs
  ~94 conversations × batched live extraction, which doesn't fit in
  reasonable container budgets. Budget-aware redesign pending (periodic
  mid-subprocess commits, conversation-level splitting, or cheaper
  stress-test model).
- Band rule reminder: updateRate < 0.1 = too strict (dedup rarely fires),
  updateRate > 0.5 = too lax (over-merges distinct facts). Target [0.2, 0.4]
  closest to 0.3.
"""
    return report


@app.function(
    image=image,
    volumes={"/data": volume},
    secrets=[env_secret],
    timeout=1800,
    memory=4096,
)
def run_consolidation_batchsize_sweep() -> dict:
    """Conversation-level-split BATCH_SIZE sweep (Phase 11 Task 6).

    25 cells (5 values × 5 convs) fanned out to parallel containers,
    then aggregated into one MetricsResult per BATCH_SIZE value.

    Returns:
        Dict with keys { report, result_json, run_dir }.
    """
    import json
    import math
    import os
    from datetime import datetime

    pairs = [(ci, bs) for bs in BATCHSIZE_VALUES for ci in BATCHSIZE_CONV_INDICES]

    cell_results = list(run_batchsize_point.map(
        [p[0] for p in pairs],
        [p[1] for p in pairs],
    ))
    cells = [json.loads(cr) for cr in cell_results]

    by_bs = {}
    for cell in cells:
        bs = cell.get("batchSize")
        by_bs.setdefault(bs, []).append(cell)

    def _is_nan(x):
        try:
            return math.isnan(x)
        except (TypeError, ValueError):
            return x is None

    points = []
    for bs in BATCHSIZE_VALUES:
        cells_for_bs = by_bs.get(bs, [])
        if not cells_for_bs:
            continue
        total_n = sum(c.get("metrics", {}).get("n", 0) for c in cells_for_bs)
        total_n_scored = sum(c.get("metrics", {}).get("n_scored", 0) for c in cells_for_bs)
        total_n_skipped = sum(c.get("metrics", {}).get("n_skipped", 0) for c in cells_for_bs)

        # Weighted MRR: sum(mrr * n_scored) / sum(n_scored), skipping NaN.
        mrr_num = 0.0
        mrr_den = 0
        for c in cells_for_bs:
            m = c.get("metrics", {})
            if m.get("n_scored", 0) > 0 and not _is_nan(m.get("mrr")):
                mrr_num += m["mrr"] * m["n_scored"]
                mrr_den += m["n_scored"]
        mrr_agg = (mrr_num / mrr_den) if mrr_den > 0 else float("nan")

        # Aggregate updateRate from consolidationStats
        total_updated = sum(
            (c.get("consolidationStats") or {}).get("updated", 0)
            for c in cells_for_bs
        )
        total_added = sum(
            (c.get("consolidationStats") or {}).get("added", 0)
            for c in cells_for_bs
        )
        update_rate = (
            total_updated / (total_updated + total_added)
            if (total_updated + total_added) > 0
            else 0.0
        )

        points.append({
            "overrides": {"BATCH_SIZE": bs},
            "metrics": {
                "n": total_n,
                "n_scored": total_n_scored,
                "n_skipped": total_n_skipped,
                "coverage": (total_n_scored / total_n) if total_n > 0 else float("nan"),
                "mrr": mrr_agg,
                "updateRate": update_rate,
            },
            "cells": cells_for_bs,
        })

    ts = datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-batchsize"
    os.makedirs(run_dir, exist_ok=True)

    knobs = [{"name": "BATCH_SIZE", "values": BATCHSIZE_VALUES}]
    elbow = _detect_elbow(points, knobs, "mrr") if len(points) >= 2 else None

    result_payload = {
        "name": "batchsize",
        "timestamp": ts,
        "points": points,
        "elbow": elbow,
        "convs_sampled": BATCHSIZE_CONV_INDICES,
    }
    result_json_str = json.dumps(result_payload, indent=2)
    with open(f"{run_dir}/result.json", "w") as f:
        f.write(result_json_str)

    report = render_batchsize_report(result_payload)
    with open(f"{run_dir}/report.md", "w") as f:
        f.write(report)

    volume.commit()
    return {"report": report, "result_json": result_json_str, "run_dir": run_dir}


def render_batchsize_report(payload):
    lines = []
    lines.append(f"# BATCH_SIZE sweep — {payload['timestamp']}")
    lines.append("")
    lines.append(f"**Convs sampled:** indices {payload['convs_sampled']}")
    lines.append("")
    lines.append("| BATCH_SIZE | MRR | Coverage | Update rate | n (QA) |")
    lines.append("|---|---|---|---|---|")
    for pt in payload["points"]:
        bs = pt["overrides"]["BATCH_SIZE"]
        m = pt["metrics"]
        lines.append(
            f"| {bs} | {m['mrr']:.4f} | {m['coverage']:.4f} | {m.get('updateRate', 0):.4f} | {m['n']} |"
        )
    lines.append("")
    # Amendment verdict (Task 4 rule)
    if len(payload["points"]) >= 2:
        baseline_pt = next(
            (p for p in payload["points"] if p["overrides"]["BATCH_SIZE"] == 10),
            payload["points"][0],
        )
        if payload.get("elbow", {}).get("overrides"):
            chosen_bs = payload["elbow"]["overrides"].get("BATCH_SIZE")
            candidate_pt = next(
                (p for p in payload["points"] if p["overrides"]["BATCH_SIZE"] == chosen_bs),
                None,
            )
            if candidate_pt and candidate_pt is not baseline_pt:
                verdict = _should_amend(baseline_pt["metrics"], candidate_pt["metrics"])
                lines.append("### Amendment verdict")
                lines.append("")
                lines.append(f"{'**Amend**' if verdict['amend'] else '**Held at spec**'} — {verdict['reason']}")
                lines.append("")
    lines.append(f"**Elbow rationale:** {payload.get('elbow', {}).get('rationale', '—') if payload.get('elbow') else '—'}")
    return "\n".join(lines)


def run_consolidation_sweep(synthetic: bool = False) -> dict:
    """Run two independent consolidation knob sweeps.

    Each round is a single-axis parallel fan-out via run_point.map().
    Pre-registered Branch C flags rounds with MRR range below the
    CONSOLIDATION_FLAT_MRR_THRESHOLD as "flat" and defers tuning to
    9.5 live extraction. Non-flat rounds land an elbow at the
    MRR-best point.

    Called from run_sweep when sweep_name='consolidation'. Returns
    the standard {report, result_json, run_dir} shape.
    """
    import os
    from datetime import datetime, timezone

    rounds_out = []
    last_points = []

    for round_def in CONSOLIDATION_ROUNDS:
        knob_name = round_def["knob"]
        values = round_def["values"][:2] if synthetic else round_def["values"]
        grid = [{knob_name: v} for v in values]
        overrides_jsons = [json.dumps(p) for p in grid]
        point_results = list(run_point.map(overrides_jsons))
        points = [json.loads(pr) for pr in point_results]
        last_points = points

        # Branch C detection: MRR range below noise floor
        mrr_values = [p["metrics"]["mrr"] for p in points]
        mrr_range = max(mrr_values) - min(mrr_values)
        is_flat = mrr_range < CONSOLIDATION_FLAT_MRR_THRESHOLD

        if is_flat:
            elbow = {"value": None, "mrr": max(mrr_values), "flat": True}
        else:
            winner = max(points, key=lambda p: p["metrics"]["mrr"])
            elbow = {
                "value": winner["overrides"][knob_name],
                "mrr": winner["metrics"]["mrr"],
                "flat": False,
            }

        rounds_out.append({
            "name": round_def["name"],
            "knob": knob_name,
            "values": values,
            "points": points,
            "elbow": elbow,
            "mrr_range": mrr_range,
        })

    # Persistence — mirrors graph + tau/bm25 pattern
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    run_dir = f"/data/runs/{ts}-consolidation"
    os.makedirs(run_dir, exist_ok=True)

    payload = {
        "_schema": 1,
        "sweep_name": "consolidation",
        "synthetic": synthetic,
        "timestamp": ts,
        "corpus_len": 10,
        "qa_count": last_points[0]["runCount"] if last_points else 0,
        "rounds": rounds_out,
    }
    result_json_str = json.dumps(payload, indent=2)
    report = render_consolidation_report_stub(payload)

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
        sweep_name: 'tau', 'bm25', 'hops', 'relw', 'graph', or 'consolidation'.
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
    if sweep_name == "batchsize":
        return run_consolidation_batchsize_sweep()
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
        elif sweep_name == "bm25":
            grid = [
                {"TAG_BOOST": 2, "SUBJECT_BOOST": 2},  # spec defaults
                {"TAG_BOOST": 3, "SUBJECT_BOOST": 2},  # +tag variant
            ]
        elif sweep_name == "hops":
            grid = [
                {"TIER3_MAX_HOPS": 2, "TIER2_TAU_GAP": 10},  # spec default + gap=10
                {"TIER3_MAX_HOPS": 3, "TIER2_TAU_GAP": 10},  # +1 hop variant
            ]
        elif sweep_name == "relw":
            grid = [
                {"EXPLICIT_RELATION_WEIGHT": 1.0, "TIER2_TAU_GAP": 10},  # spec default + gap=10
                {"EXPLICIT_RELATION_WEIGHT": 2.0, "TIER2_TAU_GAP": 10},  # +1.0 variant
            ]
        else:
            raise ValueError(f"Unknown synthetic sweep_name: {sweep_name!r}")
    else:
        grid = _cartesian_product(knobs)
        # 9.5: single-axis graph-tier sweeps need TIER2_TAU_GAP=10 inlined
        # into every grid point so queries actually reach Tier 3 (without
        # it, Tier 2 gating short-circuits and the knob is inert by
        # construction). Same invariant as GRAPH_BASE_OVERRIDES; run_sweep
        # doesn't honor a config["base_overrides"] key today, so we inline.
        if sweep_name in ("hops", "relw"):
            for point in grid:
                point.setdefault("TIER2_TAU_GAP", 10)

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

        modal run bench/modal/sweep_app.py --mode run-point \\
                --overrides-json '{"TIER2_TAU_GAP": 10}' --local-out docs/bench/runs
            → run_point() with override + mirrors {ts}-point.json to host dir
              (stem convention matches run-sweep)

        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name batchsize
            → 25-cell (5 BATCH_SIZE × 5 convs) split sweep, ~3min parallel

        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name tau --synthetic
            → runs run_sweep() with synthetic corpus (2 points)

        modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name tau \\
                --local-out docs/bench/runs
            → also mirrors report.md + result.json to the host dir
              (independent of the Modal Volume copy at /data/runs/<ts>-<sweep>/)

        modal run bench/modal/sweep_app.py --mode run-baselines --local-out docs/bench/baselines
            → fans out 4 baseline retrievers to parallel Modal containers,
              writes {ts}-baselines.{md,json} to host dir
    """
    if mode == "hello":
        print(json.dumps(hello.remote(), indent=2))
    elif mode == "run-point":
        result_str = run_point.remote(overrides_json)
        print(result_str)
        if local_out:
            from datetime import datetime as _dt
            from pathlib import Path as _Path
            out = _Path(local_out).expanduser()
            out.mkdir(parents=True, exist_ok=True)
            # Stem mirrors run-sweep's convention: ISO-ish timestamp + 'point'.
            stem = _dt.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ") + "-point"
            (out / f"{stem}.json").write_text(result_str)
            print(
                f"<!-- mirrored to host: {out / stem}.json -->",
                file=__import__("sys").stderr,
            )
    elif mode == "run-baselines":
        baselines_out = run_baselines.remote()
        report = baselines_out["report"]
        result_json_str = baselines_out["result_json"]
        run_dir = baselines_out["run_dir"]
        print(report)
        print(f"\n<!-- saved to Modal Volume: {run_dir} -->", file=__import__("sys").stderr)
        if local_out:
            from pathlib import Path as _Path
            out = _Path(local_out).expanduser()
            out.mkdir(parents=True, exist_ok=True)
            stem = os.path.basename(run_dir)
            (out / f"{stem}.md").write_text(report)
            (out / f"{stem}.json").write_text(result_json_str)
            print(f"<!-- mirrored to host: {out / stem}.{{md,json}} -->", file=__import__("sys").stderr)
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
        print(f"Unknown mode: {mode!r}. Expected 'hello', 'run-point', 'run-baselines', or 'run-sweep'.")
