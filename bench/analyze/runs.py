"""Analyze STARmem bench artifacts with Polars — on-disk companion to traces.py.

traces.py inspects Weave/W&B traces (what happened on the call path).
runs.py inspects docs/bench/runs/*.json and *.jsonl artifacts (what the
harness wrote out). Together they cover both ends of the observability
story without fighting a web UI.

Subcommands:

    python bench/analyze/runs.py sweeps            # tabulate all sweep points
    python bench/analyze/runs.py sweeps --knob TIER3_LAMBDA_1
    python bench/analyze/runs.py sweeps --sweep-name graph --since 2026-04-22
    python bench/analyze/runs.py sweeps --format csv > sweeps.csv
    python bench/analyze/runs.py runs               # tabulate per-call retrievals
    python bench/analyze/runs.py runs --run 2026-04-21-21-37-46
    python bench/analyze/runs.py diff <sweep-a> <sweep-b>  # ΔMRR on shared knob values

Design notes:

- One long-form DataFrame per loader. Sweep artifacts come in four shapes;
  all four are normalised into (timestamp, sweep_name, round, knob, value,
  mrr, coverage, n, n_scored, latency_p50, latency_p95, is_winner, file).
- Baselines JSON uses retrieverId-as-knob so it rides the same schema.
- Polars chosen over Pandas: expression API keeps the code grep-auditable,
  lazy eval scales if the artifact set grows, zero-dep install. Hand off
  to pandas at the boundary with df.to_pandas() if wandb.Table wants it.

This is a disposable analysis script, not a durable harness module.
If it turns out useful, promote to bench/; if not, delete.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable

import polars as pl


# docs/bench/runs lives two levels up from this file.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_RUNS_DIR = REPO_ROOT / "docs" / "bench" / "runs"


# --------------------------------------------------------------------------
# Sweep loader — four-shape normaliser
# --------------------------------------------------------------------------

SWEEP_SCHEMA = {
    "file": pl.Utf8,
    "timestamp": pl.Utf8,
    "sweep_name": pl.Utf8,
    "round": pl.Utf8,
    "knob": pl.Utf8,
    "value": pl.Utf8,  # kept as string because values mix ints/floats/retriever-ids
    "mrr": pl.Float64,
    "coverage": pl.Float64,
    "n": pl.Int64,
    "n_scored": pl.Int64,
    "n_skipped": pl.Int64,
    "latency_p50": pl.Float64,
    "latency_p95": pl.Float64,
    "is_winner": pl.Boolean,
}


def _metric_row(point: dict) -> dict:
    """Pull metrics/latency fields from a sweep point. Safe against shape drift."""
    m = point.get("metrics") or {}
    lat = point.get("latencyMs")
    # latencyMs is either {p50, p95} (sweep shape) or a scalar (baselines shape).
    if isinstance(lat, dict):
        p50 = lat.get("p50")
        p95 = lat.get("p95")
    elif isinstance(lat, (int, float)):
        p50, p95 = float(lat), None
    else:
        p50, p95 = None, None

    cov = m.get("coverage")
    if cov is None and m.get("n") and m.get("n_scored") is not None:
        cov = m["n_scored"] / m["n"] if m["n"] else None

    return {
        "mrr": m.get("mrr"),
        "coverage": cov,
        "n": m.get("n"),
        "n_scored": m.get("n_scored"),
        "n_skipped": m.get("n_skipped"),
        "latency_p50": p50,
        "latency_p95": p95,
    }


def _rows_from_rounds(payload: dict, rounds: list[dict], file: str) -> Iterable[dict]:
    """Shape 1 + 2: coord-descent (rounds → points), each point's override
    dict contains the current round's knob. Winner = round.winner.value."""
    ts = payload.get("timestamp", "")
    sweep = payload.get("sweep_name", payload.get("name", "unknown"))
    for r in rounds:
        knob = r.get("knob")
        round_name = r.get("name", knob)
        winner_value = (r.get("winner") or {}).get("value")
        for pt in r.get("points") or []:
            value = (pt.get("overrides") or {}).get(knob)
            met = _metric_row(pt)
            yield {
                "file": file,
                "timestamp": ts,
                "sweep_name": sweep,
                "round": round_name,
                "knob": knob,
                "value": str(value) if value is not None else None,
                **met,
                "is_winner": value == winner_value,
            }


def _rows_from_flat_points(
    payload: dict, points: list[dict], file: str, sweep_name: str | None = None
) -> Iterable[dict]:
    """Shape 3: single-knob sweep (tau, hops, bm25, relw) where result.points
    is a flat list. The knob isn't named at top level — infer from the first
    differing override key, or fall back to all override keys joined."""
    ts = payload.get("timestamp", "")
    sweep = sweep_name or payload.get("sweep_name", payload.get("name", "unknown"))

    # Detect varying knobs across points so multi-knob grids (e.g. tau) get
    # one row per (knob × point) rather than collapsing.
    all_keys: set[str] = set()
    for pt in points:
        all_keys.update((pt.get("overrides") or {}).keys())
    # A knob is "varying" if it takes >1 distinct value across points.
    varying = []
    for k in sorted(all_keys):
        seen = {(pt.get("overrides") or {}).get(k) for pt in points}
        if len(seen) > 1:
            varying.append(k)
    if not varying:  # degenerate — emit rows keyed on all override keys joined
        varying = sorted(all_keys) or ["(no-overrides)"]

    for pt in points:
        overrides = pt.get("overrides") or {}
        met = _metric_row(pt)
        for knob in varying:
            yield {
                "file": file,
                "timestamp": ts,
                "sweep_name": sweep,
                "round": knob,
                "knob": knob,
                "value": str(overrides.get(knob)) if overrides.get(knob) is not None else None,
                **met,
                "is_winner": False,  # flat sweeps don't carry a winner field
            }


def _rows_from_baselines(payload: dict, points: list[dict], file: str) -> Iterable[dict]:
    """Shape 4: baselines — points keyed by retrieverId, not override value.
    Rides the schema by treating retrieverId as the knob value and
    'retriever' as the knob name."""
    ts = payload.get("timestamp", "")
    for pt in points:
        met = _metric_row(pt)
        yield {
            "file": file,
            "timestamp": ts,
            "sweep_name": "baselines",
            "round": "baselines",
            "knob": "retriever",
            "value": pt.get("retrieverId"),
            **met,
            "is_winner": False,
        }


def _iter_sweep_rows(payload: dict, file: str) -> Iterable[dict]:
    """Dispatch on the four known sweep-artifact shapes."""
    # Shape 1: coord-descent, rounds at top level (graph, consolidation)
    if isinstance(payload.get("rounds"), list):
        yield from _rows_from_rounds(payload, payload["rounds"], file)
        return

    # Shape 2 & 3: result-wrapped
    if isinstance(payload.get("result"), dict):
        res = payload["result"]
        if isinstance(res.get("rounds"), list):
            yield from _rows_from_rounds(payload, res["rounds"], file)
            return
        if isinstance(res.get("points"), list):
            yield from _rows_from_flat_points(
                payload, res["points"], file,
                sweep_name=payload.get("sweep_name") or res.get("name"),
            )
            return

    # Shape 4: baselines — flat top-level points keyed by retrieverId
    if isinstance(payload.get("points"), list):
        if payload["points"] and payload["points"][0].get("retrieverId"):
            yield from _rows_from_baselines(payload, payload["points"], file)
            return
        # Unlikely but defensive: knob-style points at top level
        yield from _rows_from_flat_points(payload, payload["points"], file)


def load_sweeps(runs_dir: Path = DEFAULT_RUNS_DIR) -> pl.DataFrame:
    """Scan runs_dir for *.json sweep artifacts (excluding *.metrics.json)
    and return a long-form Polars DataFrame."""
    files = sorted(
        p for p in runs_dir.glob("*.json")
        if not p.name.endswith(".metrics.json")
    )
    rows: list[dict] = []
    for p in files:
        try:
            payload = json.loads(p.read_text())
        except json.JSONDecodeError as exc:
            print(f"[warn] skip {p.name}: {exc}", file=sys.stderr)
            continue
        try:
            rows.extend(_iter_sweep_rows(payload, p.name))
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] skip {p.name} (shape mismatch: {exc})", file=sys.stderr)
    if not rows:
        # Build an empty frame with the declared schema so downstream
        # aggregations don't crash on missing columns.
        return pl.DataFrame(schema=SWEEP_SCHEMA)
    return pl.DataFrame(rows, schema_overrides=SWEEP_SCHEMA)


# --------------------------------------------------------------------------
# Per-call loader — .jsonl + .metrics.json pairs
# --------------------------------------------------------------------------

def load_runs(runs_dir: Path = DEFAULT_RUNS_DIR, run_id: str | None = None) -> pl.DataFrame:
    """Scan for *.jsonl local-bench runs. Each row in a run's jsonl is one
    retrieval. The sibling .metrics.json holds aggregate mrr/recall/etc. —
    we attach scorer_id / git_sha / node_version from envSnapshot so rows
    can be filtered by bench-environment identity.

    run_id: optional stem match (e.g. '2026-04-21-21-37-46')."""
    files = sorted(runs_dir.glob("*.jsonl"))
    if run_id:
        files = [p for p in files if run_id in p.stem]
    if not files:
        return pl.DataFrame()

    rows: list[dict] = []
    for p in files:
        meta_path = p.with_suffix(".metrics.json")
        envsnap = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                envsnap = meta.get("envSnapshot") or {}
            except json.JSONDecodeError:
                pass

        scorer = envsnap.get("scorerId")
        git_sha = envsnap.get("gitSha")
        node_ver = envsnap.get("nodeVersion")

        with p.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                retrieved = rec.get("retrieved") or []
                top = retrieved[0] if retrieved else {}
                rows.append({
                    "run": p.stem,
                    "scorer_id": scorer,
                    "git_sha": git_sha,
                    "node_version": node_ver,
                    "conversation_id": rec.get("conversationId"),
                    "question": (rec.get("qa") or {}).get("question"),
                    "answer": (rec.get("qa") or {}).get("answer"),
                    "category": (rec.get("qa") or {}).get("category"),
                    "n_retrieved": len(retrieved),
                    "top_id": top.get("id"),
                    "top_score": top.get("score"),
                    "top_tier": top.get("tier"),
                })
    return pl.DataFrame(rows) if rows else pl.DataFrame()


# --------------------------------------------------------------------------
# Output formatters
# --------------------------------------------------------------------------

def emit(df: pl.DataFrame, fmt: str) -> None:
    if df.is_empty():
        print("# (empty)")
        return
    if fmt == "csv":
        sys.stdout.write(df.write_csv())
        return
    if fmt == "json":
        sys.stdout.write(df.write_json())
        sys.stdout.write("\n")
        return
    # markdown (default) — use Polars' table repr, with all cols unelided.
    with pl.Config(
        tbl_rows=df.height,
        tbl_cols=df.width,
        tbl_width_chars=180,
        fmt_str_lengths=60,
    ):
        print(df)


# --------------------------------------------------------------------------
# CLI subcommands
# --------------------------------------------------------------------------

def cmd_sweeps(args: argparse.Namespace) -> int:
    df = load_sweeps(Path(args.runs_dir))
    if df.is_empty():
        print(f"# No sweep artifacts found in {args.runs_dir}", file=sys.stderr)
        return 1

    # Apply filters.
    if args.sweep_name:
        df = df.filter(pl.col("sweep_name") == args.sweep_name)
    if args.knob:
        df = df.filter(pl.col("knob") == args.knob)
    if args.since:
        df = df.filter(pl.col("timestamp") >= args.since)
    if args.winners_only:
        df = df.filter(pl.col("is_winner"))

    # Sort by timestamp + sweep + knob + value for stable output.
    df = df.sort(["timestamp", "sweep_name", "knob", "value"])

    # Optional summary roll-up.
    if args.summary:
        roll = (
            df.group_by(["sweep_name", "knob"])
            .agg([
                pl.len().alias("n_points"),
                pl.col("mrr").min().alias("mrr_min"),
                pl.col("mrr").max().alias("mrr_max"),
                pl.col("mrr").max().sub(pl.col("mrr").min()).alias("mrr_span"),
                pl.col("coverage").mean().alias("coverage_mean"),
            ])
            .sort(["sweep_name", "knob"])
        )
        emit(roll, args.format)
        return 0

    if args.top:
        df = df.sort("mrr", descending=True).head(args.top)

    emit(df, args.format)
    return 0


def cmd_runs(args: argparse.Namespace) -> int:
    df = load_runs(Path(args.runs_dir), run_id=args.run)
    if df.is_empty():
        print(f"# No .jsonl runs found in {args.runs_dir}", file=sys.stderr)
        return 1

    if args.category is not None:
        df = df.filter(pl.col("category") == args.category)

    if args.summary:
        # Per-run aggregate: count, tier distribution as n-per-tier string, avg top_score.
        roll = (
            df.group_by("run")
            .agg([
                pl.len().alias("n_calls"),
                pl.col("top_score").mean().alias("top_score_mean"),
                pl.col("top_tier").drop_nulls().mode().first().alias("top_tier_mode"),
                pl.col("scorer_id").first(),
                pl.col("git_sha").first(),
            ])
            .sort("run")
        )
        emit(roll, args.format)
        return 0

    if args.top:
        df = df.head(args.top)
    emit(df, args.format)
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    df = load_sweeps(Path(args.runs_dir))
    a = df.filter(pl.col("file") == args.file_a)
    b = df.filter(pl.col("file") == args.file_b)
    if a.is_empty() or b.is_empty():
        missing = []
        if a.is_empty():
            missing.append(args.file_a)
        if b.is_empty():
            missing.append(args.file_b)
        print(f"# No rows for: {', '.join(missing)}", file=sys.stderr)
        return 1

    join_keys = ["knob", "value"]
    joined = (
        a.select(join_keys + ["mrr", "coverage"])
        .rename({"mrr": "mrr_a", "coverage": "coverage_a"})
        .join(
            b.select(join_keys + ["mrr", "coverage"])
            .rename({"mrr": "mrr_b", "coverage": "coverage_b"}),
            on=join_keys,
            how="inner",
        )
        .with_columns([
            (pl.col("mrr_b") - pl.col("mrr_a")).alias("delta_mrr"),
            (pl.col("coverage_b") - pl.col("coverage_a")).alias("delta_coverage"),
        ])
        .sort(pl.col("delta_mrr").abs(), descending=True)
    )
    emit(joined, args.format)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--runs-dir", default=str(DEFAULT_RUNS_DIR),
        help=f"Directory holding bench artifacts (default: {DEFAULT_RUNS_DIR})",
    )
    parser.add_argument(
        "--format", choices=["md", "csv", "json"], default="md",
        help="Output format (default: md — Polars table repr)",
    )

    sub = parser.add_subparsers(dest="cmd", required=True)

    sw = sub.add_parser("sweeps", help="Tabulate sweep artifact points")
    sw.add_argument("--sweep-name", help="Filter by sweep_name (graph, tau, bm25, ...)")
    sw.add_argument("--knob", help="Filter by knob (e.g. TIER3_LAMBDA_1)")
    sw.add_argument("--since", help="ISO timestamp prefix, lexicographic (e.g. 2026-04-22)")
    sw.add_argument("--winners-only", action="store_true", help="Only rows where is_winner")
    sw.add_argument("--summary", action="store_true", help="Roll up by (sweep_name, knob)")
    sw.add_argument("--top", type=int, help="Top-N by MRR (after filters)")
    sw.set_defaults(func=cmd_sweeps)

    rn = sub.add_parser("runs", help="Tabulate per-call retrievals from jsonl")
    rn.add_argument("--run", help="Filter by run-id substring (e.g. 2026-04-21-21-37-46)")
    rn.add_argument("--category", type=int, help="Filter by qa.category")
    rn.add_argument("--summary", action="store_true", help="Roll up per run")
    rn.add_argument("--top", type=int, help="First-N rows after filters")
    rn.set_defaults(func=cmd_runs)

    df = sub.add_parser("diff", help="ΔMRR between two sweep artifacts on shared (knob, value)")
    df.add_argument("file_a", help="First sweep filename (e.g. 2026-04-22T15-50-28Z-graph.json)")
    df.add_argument("file_b", help="Second sweep filename")
    df.set_defaults(func=cmd_diff)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
