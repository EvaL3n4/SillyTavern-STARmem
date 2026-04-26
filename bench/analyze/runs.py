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
    python bench/analyze/runs.py sweeps --format html > sweeps.html
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

# --------------------------------------------------------------------------
# Column formatting — shared by md + html emitters
# --------------------------------------------------------------------------

# Per-column display rules. Missing columns pass through as str().
# Goal: terse, tabular-nums friendly, mobile-pasteable.
_FLOAT_FMT = {
    "mrr": ".4f",
    "coverage": ".4f",
    "mrr_min": ".4f",
    "mrr_max": ".4f",
    "mrr_span": ".4f",
    "coverage_mean": ".4f",
    "latency_p50": ".2f",
    "latency_p95": ".2f",
    "delta_mrr": "+.4f",
    "delta_coverage": "+.4f",
    "top_score": ".4f",
    "top_score_mean": ".4f",
    "mrr_a": ".4f",
    "mrr_b": ".4f",
    "coverage_a": ".4f",
    "coverage_b": ".4f",
}

# Numeric columns get tabular-nums alignment + right-justified in HTML.
_NUMERIC_COLS = set(_FLOAT_FMT.keys()) | {
    "n", "n_points", "n_scored", "n_skipped", "n_calls", "n_retrieved",
}


def _fmt_cell(col: str, val) -> str:
    """Render one cell for md/html output."""
    if val is None:
        return ""
    if isinstance(val, bool):
        return "✓" if val else ""
    if isinstance(val, float):
        spec = _FLOAT_FMT.get(col)
        if spec:
            return format(val, spec)
        return format(val, ".4g")
    if col == "file" and isinstance(val, str) and val.endswith(".json"):
        # Strip the .json extension; it's noise in every row.
        val = val[:-5]
    if col == "timestamp" and isinstance(val, str) and len(val) >= 17:
        # "2026-04-24T08-23-48Z" → "04-24 08:23" (date + HH:MM, drop year + secs).
        # The full stamp is already in the filename; here we just need orientation.
        try:
            return f"{val[5:10]} {val[11:13]}:{val[14:16]}"
        except Exception:  # noqa: BLE001
            return str(val)
    return str(val)


def _df_to_cells(df: pl.DataFrame) -> tuple[list[str], list[list[str]]]:
    cols = df.columns
    rows = [[_fmt_cell(c, v) for c, v in zip(cols, row)] for row in df.iter_rows()]
    return cols, rows


# --------------------------------------------------------------------------
# Output formatters
# --------------------------------------------------------------------------

def _emit_md(df: pl.DataFrame) -> None:
    """GitHub-flavoured pipe table. Paste-clean in chat, Obsidian, and GitHub."""
    cols, rows = _df_to_cells(df)
    # Header.
    print("| " + " | ".join(cols) + " |")
    # Alignment row: right-align numeric, left-align text.
    aligns = ["---:" if c in _NUMERIC_COLS else "---" for c in cols]
    print("| " + " | ".join(aligns) + " |")
    for row in rows:
        # Escape pipes in cell values so they don't break the table.
        print("| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |")


def _emit_html(df: pl.DataFrame) -> None:
    """Single self-contained HTML file. Mobile: stacks into cards. Desktop: table.

    No CDN, no JS. Auto light/dark via prefers-color-scheme. System fonts.
    Matches the Claude-Code minimal aesthetic: matte surfaces, subtle borders,
    tabular-nums for the numeric columns, left-border accent on is_winner rows.
    """
    cols, rows = _df_to_cells(df)
    winner_idx = cols.index("is_winner") if "is_winner" in cols else -1

    # Find the first string column to use as the card heading on mobile.
    # Preference order: sweep_name > knob > run > file > first column.
    heading_col = next(
        (c for c in ("sweep_name", "knob", "run", "file") if c in cols),
        cols[0] if cols else "",
    )
    heading_idx = cols.index(heading_col) if heading_col in cols else 0

    def esc(s: str) -> str:
        return (s.replace("&", "&amp;").replace("<", "&lt;")
                 .replace(">", "&gt;").replace('"', "&quot;"))

    # Build <tbody> rows. Each row carries both a table-row layout (desktop)
    # and a definition-list fallback (mobile, via CSS media query).
    body_html: list[str] = []
    for row in rows:
        is_winner = winner_idx >= 0 and row[winner_idx] == "✓"
        tr_attr = ' class="winner"' if is_winner else ""
        card_cls = " winner" if is_winner else ""
        # Desktop: <tr><td>...</td></tr>
        tds = "".join(
            f'<td class="num">{esc(cell)}</td>' if cols[i] in _NUMERIC_COLS
            else f'<td>{esc(cell)}</td>'
            for i, cell in enumerate(row)
        )
        # Mobile: a card with a heading + <dl> pairs for the rest.
        dl_pairs = "".join(
            f'<dt>{esc(cols[i])}</dt><dd class="{"num" if cols[i] in _NUMERIC_COLS else ""}">'
            f'{esc(cell)}</dd>'
            for i, cell in enumerate(row) if i != heading_idx
        )
        heading_val = row[heading_idx] if 0 <= heading_idx < len(row) else ""
        card = (
            f'<div class="card-head">{esc(heading_val) or "&nbsp;"}</div>'
            f'<dl>{dl_pairs}</dl>'
        )
        body_html.append(f'<tr{tr_attr}>{tds}</tr>')
        body_html.append(f'<div class="card{card_cls}">{card}</div>')

    ths = "".join(
        f'<th class="num">{esc(c)}</th>' if c in _NUMERIC_COLS
        else f'<th>{esc(c)}</th>'
        for c in cols
    )

    # Palette: matte dark (#0f1115 / #e6e6e6), light mode mirrors.
    # Winner accent: muted amber, not red — success, not alert.
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STARmem bench</title>
<style>
  :root {{
    --bg: #ffffff; --fg: #1a1a1a;
    --muted: #6b7280; --border: #e5e7eb; --surface: #f8f9fa;
    --accent: #b45309; --winner-bg: #fef3c7;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #0f1115; --fg: #e6e6e6;
      --muted: #9ca3af; --border: #2a2e37; --surface: #161923;
      --accent: #f59e0b; --winner-bg: #2a2418;
    }}
  }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; background: var(--bg); color: var(--fg); }}
  body {{
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 16px;
    max-width: 1400px; margin: 0 auto;
  }}
  .num {{
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }}
  /* Desktop table */
  table {{
    width: 100%; border-collapse: collapse;
    font-size: 13px;
  }}
  thead th {{
    position: sticky; top: 0; background: var(--surface);
    text-align: left; font-weight: 600;
    padding: 8px 10px; border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }}
  th.num, td.num {{ text-align: right; }}
  tbody td {{
    padding: 6px 10px; border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }}
  tbody tr:hover {{ background: var(--surface); }}
  tr.winner td {{
    background: var(--winner-bg);
  }}
  tr.winner td:first-child {{
    border-left: 3px solid var(--accent);
    padding-left: 7px;
  }}
  /* Mobile cards — hidden on desktop */
  .cards {{ display: none; }}
  .card {{
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px 14px; margin-bottom: 10px;
  }}
  .card.winner {{
    border-left: 3px solid var(--accent);
  }}
  .card-head {{
    font-weight: 600; font-size: 15px; margin-bottom: 8px;
    padding-bottom: 6px; border-bottom: 1px solid var(--border);
  }}
  .card dl {{
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px; margin: 0;
  }}
  .card dt {{ color: var(--muted); font-size: 12px; }}
  .card dd {{ margin: 0; font-size: 13px; }}
  @media (max-width: 640px) {{
    body {{ padding: 10px; font-size: 13px; }}
    table {{ display: none; }}
    .cards {{ display: block; }}
  }}
</style>
</head>
<body>
<table>
<thead><tr>{ths}</tr></thead>
<tbody>
{''.join(r for r in body_html if r.startswith('<tr'))}
</tbody>
</table>
<div class="cards">
{''.join(r for r in body_html if r.startswith('<div class="card'))}
</div>
</body>
</html>
"""
    sys.stdout.write(html)


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
    if fmt == "html":
        _emit_html(df)
        return
    # Default: GitHub pipe-table markdown. Paste-clean in any markdown viewer.
    _emit_md(df)


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
        "--format", choices=["md", "csv", "json", "html"], default="md",
        help="Output format (default: md — GitHub pipe-table; html writes a mobile-friendly page)",
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
