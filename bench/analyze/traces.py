"""Analyze Weave traces for STARmem bench retrieval calls (Polars-backed).

Pulls recent ladder() calls from Weave via the Python SDK, materialises them
into a Polars DataFrame, and produces a terminal-friendly markdown report
covering:

- Latency distribution (p50/p95/p99/min/max/mean/stdev)
- Tier-resolved distribution
- Top-N slowest / fastest queries with truncated inputs
- Query-length vs latency correlation (Pearson r)

Companion to bench/analyze/runs.py (on-disk artifacts). Pass --join-runs to
enrich trace rows with on-disk per-call metadata (scorer_id, git_sha, top_tier,
category) via an inner join on (question).

Usage:

    python bench/analyze/traces.py                      # default report
    python bench/analyze/traces.py --limit 200 --top 10
    python bench/analyze/traces.py --tier 3             # only Tier 3 resolves
    python bench/analyze/traces.py --format csv         # pipe-friendly
    python bench/analyze/traces.py --join-runs          # enrich via runs.py

This is a disposable analysis script, not a durable harness module.
If it turns out to be useful, move it into bench/ properly. If not,
delete it — the W&B traces themselves are the real artifact.

Auth: reads ~/.netrc for api.wandb.ai, same as `wandb login`.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import polars as pl


# Make sibling bench/analyze/runs.py importable when traces.py is run
# directly (`python bench/analyze/traces.py`). The join-runs path pulls
# load_runs() from it.
sys.path.insert(0, str(Path(__file__).resolve().parent))


# --------------------------------------------------------------------------
# Small formatters
# --------------------------------------------------------------------------

def fmt_query(s: str | None, maxlen: int = 80) -> str:
    if not s:
        return "<no query>"
    if len(s) <= maxlen:
        return repr(s)
    return repr(s[: maxlen - 1] + "…")


def extract_tier(output) -> int | str | None:
    """Pull tierResolved from the retrieve() output dict."""
    if isinstance(output, dict):
        return output.get("tierResolved")
    return None


def extract_query(inputs) -> str | None:
    """Pull the query string from call inputs. retrieve() signature is
    (state, queryStr, opts), so queryStr is positional arg 1.

    Weave stores inputs in multiple shapes across versions:
    - {"state": ..., "queryStr": ..., "opts": ...}  (param-name introspection)
    - {"0": state, "1": queryStr, "2": opts}  (stringified positional)
    - {0: state, 1: queryStr, 2: opts}  (int positional)
    - {"args": [state, queryStr, opts]}  (args-array shape)
    - {"self": state, "queryStr": ..., ...}  (method-like shape)
    - {"arg0", "arg1", ...}  (Weave JS SDK — production shape)
    """
    if not isinstance(inputs, dict):
        return None

    candidates = []
    for key in ("arg1", "queryStr", "query", "q", "1", 1):
        if key in inputs:
            candidates.append(inputs[key])

    args = inputs.get("args")
    if isinstance(args, list) and len(args) >= 2:
        candidates.append(args[1])

    # Fallback: pick the shortest short-string value in inputs
    # (state serialises to thousands of chars; queries are typically <200).
    if not candidates:
        short_strings = [
            v for v in inputs.values()
            if isinstance(v, str) and 0 < len(v) < 500
        ]
        if short_strings:
            candidates.append(min(short_strings, key=len))

    for val in candidates:
        if isinstance(val, str) and val:
            return val
    return None


# --------------------------------------------------------------------------
# Weave → DataFrame
# --------------------------------------------------------------------------

def _op_bare_name(c) -> str:
    """Extract bare op name from a Call. Weave stores it in various shapes —
    op_name (URI), _op_name (bare), or display_name."""
    raw = getattr(c, "op_name", None) or getattr(c, "_op_name", None) or ""
    if not raw:
        return getattr(c, "display_name", "") or ""
    if "/op/" in raw:
        tail = raw.split("/op/", 1)[1]
        return tail.split(":", 1)[0]
    return raw


def fetch_calls(
    project: str,
    entity: str | None,
    op: str,
    limit: int,
    since_hours: float,
) -> tuple[list, list, "dict[str,int]"]:
    """Fetch Weave calls and filter to op + time window client-side.

    Weave's op_names server filter expects full URIs (not bare names);
    passing 'ladder' matches zero rows. We fetch recent calls unfiltered
    and filter locally. Returns (filtered_calls, all_calls, op_counter).
    """
    from collections import Counter
    import weave

    project_spec = f"{entity}/{project}" if entity else project
    client = weave.init(project_spec)
    all_calls = list(client.get_calls(limit=limit))
    op_counts = Counter(_op_bare_name(c) for c in all_calls)

    since = datetime.now(timezone.utc) - timedelta(hours=since_hours)
    filtered = [
        c for c in all_calls
        if _op_bare_name(c) == op
        and c.started_at
        and c.started_at.replace(tzinfo=timezone.utc) >= since
    ]
    return filtered, all_calls, dict(op_counts)


def calls_to_dataframe(calls: list) -> pl.DataFrame:
    """Materialise Weave Calls into a Polars DataFrame.

    Columns: id, started_at, ended_at, lat_ms, tier, query, query_len.
    Rows with missing timestamps are dropped (can't compute latency).
    """
    rows = []
    for c in calls:
        if not (c.started_at and c.ended_at):
            continue
        lat_ms = (c.ended_at - c.started_at).total_seconds() * 1000.0
        q = extract_query(c.inputs)
        rows.append({
            "id": str(c.id),
            "started_at": c.started_at.isoformat() if c.started_at else None,
            "ended_at": c.ended_at.isoformat() if c.ended_at else None,
            "lat_ms": lat_ms,
            "tier": extract_tier(c.output),
            "query": q,
            "query_len": len(q) if q else None,
        })
    if not rows:
        return pl.DataFrame(schema={
            "id": pl.Utf8, "started_at": pl.Utf8, "ended_at": pl.Utf8,
            "lat_ms": pl.Float64, "tier": pl.Utf8,
            "query": pl.Utf8, "query_len": pl.Int64,
        })
    # Cast tier to string — Weave stores it as int or str depending on JS shape.
    df = pl.DataFrame(rows).with_columns(pl.col("tier").cast(pl.Utf8, strict=False))
    return df


# --------------------------------------------------------------------------
# Report sections (all Polars expressions now)
# --------------------------------------------------------------------------

def _stats_row(df: pl.DataFrame, col: str) -> dict:
    q = df.select([
        pl.col(col).quantile(0.50).alias("p50"),
        pl.col(col).quantile(0.95).alias("p95"),
        pl.col(col).quantile(0.99).alias("p99"),
        pl.col(col).min().alias("min"),
        pl.col(col).max().alias("max"),
        pl.col(col).mean().alias("mean"),
        pl.col(col).std().alias("std"),
        pl.len().alias("n"),
    ]).row(0, named=True)
    return q


def _print_report(df: pl.DataFrame, op: str, project_spec: str, since_hours: float, top: int) -> None:
    n = df.height
    print(f"# Trace analysis — {n} `{op}` calls")
    print()
    print(f"Project: `{project_spec}` · window: last {since_hours}h · generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print()

    # Latency
    s = _stats_row(df, "lat_ms")
    print("## Latency (ms)")
    print()
    print(f"- **p50**: {s['p50']:.2f}")
    print(f"- **p95**: {s['p95']:.2f}")
    print(f"- **p99**: {s['p99']:.2f}")
    print(f"- **min**: {s['min']:.2f}")
    print(f"- **max**: {s['max']:.2f}")
    std = s["std"] if s["std"] is not None else 0.0
    print(f"- **mean**: {s['mean']:.2f} ± {std:.2f}")
    print()

    # Tier distribution
    print("## Tier distribution")
    print()
    dist = (
        df.group_by("tier")
        .agg(pl.len().alias("count"))
        .with_columns((pl.col("count") * 100.0 / n).alias("pct"))
        .sort("count", descending=True)
    )
    for row in dist.iter_rows(named=True):
        label = row["tier"] if row["tier"] is not None else "(none)"
        print(f"- Tier `{label}`: {row['count']} ({row['pct']:.1f}%)")
    print()

    # Sorted once; reuse for slowest + fastest.
    by_lat = df.sort("lat_ms")

    print(f"## Top {top} slowest")
    print()
    print("| latency (ms) | tier | query |")
    print("|---|---|---|")
    for row in by_lat.tail(top).reverse().iter_rows(named=True):
        print(f"| {row['lat_ms']:.2f} | {row['tier']} | {fmt_query(row['query'])} |")
    print()

    print(f"## Top {top} fastest")
    print()
    print("| latency (ms) | tier | query |")
    print("|---|---|---|")
    for row in by_lat.head(top).iter_rows(named=True):
        print(f"| {row['lat_ms']:.2f} | {row['tier']} | {fmt_query(row['query'])} |")
    print()

    # Query-length × latency — Pearson r via Polars.
    with_q = df.filter(pl.col("query_len").is_not_null())
    if with_q.height >= 10:
        corr = with_q.select(
            pl.corr("query_len", "lat_ms").alias("r")
        ).item()
        corr = corr if corr is not None else 0.0
        print("## Query length × latency")
        print()
        print(f"- Pearson r = **{corr:+.3f}** across {with_q.height} calls")
        if abs(corr) < 0.1:
            print("- Interpretation: no meaningful relationship — longer queries are NOT slower.")
        elif corr > 0.3:
            print("- Interpretation: moderate positive correlation — longer queries tend to be slower.")
        elif corr < -0.3:
            print("- Interpretation: moderate negative correlation — unusual, worth investigating.")
        else:
            print("- Interpretation: weak correlation — query length is a minor factor at best.")
        print()


def _emit_df(df: pl.DataFrame, fmt: str) -> None:
    if fmt == "csv":
        sys.stdout.write(df.write_csv())
        return
    if fmt == "json":
        sys.stdout.write(df.write_json())
        sys.stdout.write("\n")
        return
    # markdown — Polars repr
    with pl.Config(tbl_rows=df.height, tbl_cols=df.width, tbl_width_chars=180, fmt_str_lengths=60):
        print(df)


def _debug_dump(calls: list) -> None:
    c0 = calls[0]
    print("# DEBUG — first call structure")
    print()
    print(f"op_name: {getattr(c0, 'op_name', None)}")
    print(f"display_name: {getattr(c0, 'display_name', None)}")
    print()
    print("## inputs keys and types")
    if isinstance(c0.inputs, dict):
        for k, v in c0.inputs.items():
            print(f"  - `{k}` ({type(v).__name__}): {repr(v)[:120]}")
    else:
        print(f"  inputs is not a dict: {type(c0.inputs).__name__}")
    print()
    print("## output keys")
    if isinstance(c0.output, dict):
        for k, v in c0.output.items():
            print(f"  - `{k}` ({type(v).__name__}): {repr(v)[:80]}")
    else:
        print(f"  output is not a dict: {type(c0.output).__name__}")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default="STARmem", help="Weave project name")
    parser.add_argument("--entity", default=None, help="Weave entity (defaults to your login)")
    parser.add_argument("--op", default="ladder", help="Op name to filter on")
    parser.add_argument("--limit", type=int, default=500, help="Max calls to fetch")
    parser.add_argument("--top", type=int, default=5, help="Top-N outliers per side")
    parser.add_argument("--since-hours", type=float, default=24, help="Only calls newer than this many hours")
    parser.add_argument("--tier", help="Filter to calls that resolved at this tier")
    parser.add_argument("--join-runs", action="store_true",
                        help="Enrich trace rows with on-disk metadata via runs.py::load_runs (join on question)")
    parser.add_argument("--format", choices=["md", "csv", "json"], default="md",
                        help="Output format. md = narrative report (default); csv/json emit the trace DataFrame.")
    parser.add_argument("--json", action="store_true",
                        help="Legacy: dump raw calls as JSONL (same as --format json but preserves the compact per-call schema).")
    parser.add_argument("--debug", action="store_true", help="Dump first call's raw inputs/output for schema inspection")
    args = parser.parse_args(argv)

    project_spec = f"{args.entity}/{args.project}" if args.entity else args.project
    calls, all_calls, op_counts = fetch_calls(
        args.project, args.entity, args.op, args.limit, args.since_hours,
    )

    if not calls:
        print(f"# No `{args.op}` calls found in the last {args.since_hours}h.")
        print()
        print(f"Checked project: {project_spec}")
        print(f"Total calls fetched (any op): {len(all_calls)}")
        if op_counts:
            print(f"Op names seen: {op_counts}")
        print("If you expected traces, verify:")
        print(f"  - Recent run actually called initWeave('{args.project}')")
        print(f"  - ~/.netrc has a machine api.wandb.ai entry")
        print(f"  - Op name '{args.op}' matches one of the above")
        return 0

    if args.debug:
        _debug_dump(calls)
        return 0

    if args.json:
        # Legacy compact shape — matches the pre-refactor emit.
        for c in calls:
            payload = {
                "id": str(c.id),
                "started_at": c.started_at.isoformat() if c.started_at else None,
                "ended_at": c.ended_at.isoformat() if c.ended_at else None,
                "inputs_query": extract_query(c.inputs),
                "tier": extract_tier(c.output),
            }
            print(json.dumps(payload))
        return 0

    df = calls_to_dataframe(calls)
    if args.tier is not None:
        df = df.filter(pl.col("tier") == args.tier)
        if df.is_empty():
            print(f"# No calls at tier `{args.tier}` in the window.", file=sys.stderr)
            return 1

    if args.join_runs:
        # Lazy import so the default path stays polars-only.
        from runs import load_runs
        runs_df = load_runs()
        if runs_df.is_empty():
            print("# --join-runs requested but no *.jsonl runs found; emitting traces only.", file=sys.stderr)
        else:
            # Inner join on question — trace queries should match on-disk qa.question
            # for ladder calls driven by the bench harness. Polars raises cleanly on
            # schema mismatch; wrap defensively.
            try:
                df = df.join(
                    runs_df.select(["run", "scorer_id", "git_sha", "conversation_id",
                                    "question", "category", "top_tier", "top_score"])
                    .rename({"question": "query"}),
                    on="query",
                    how="left",
                )
            except Exception as exc:  # noqa: BLE001
                print(f"# --join-runs failed: {exc}", file=sys.stderr)

    if args.format in ("csv", "json"):
        _emit_df(df, args.format)
        return 0

    # Markdown narrative report (default)
    _print_report(df, args.op, project_spec, args.since_hours, args.top)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
