"""Analyze Weave traces for STARmem bench retrieval calls.

Pulls recent ladder() calls from Weave via the Python SDK and produces
a terminal-friendly markdown report covering:

- Latency distribution (p50/p95/p99/min/max)
- Tier-resolved distribution
- Top-N slowest and fastest queries with truncated inputs
- Query-length vs latency correlation (rough scatter check)

Usage:
    python bench/analyze/traces.py
    python bench/analyze/traces.py --limit 200 --top 10

This is a disposable analysis script, not a durable harness module.
If it turns out to be useful, move it into bench/ properly. If not,
delete it — the W&B traces themselves are the real artifact.

Auth: reads ~/.netrc for api.wandb.ai, same as `wandb login`.
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter
from datetime import datetime, timedelta, timezone

import weave


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
    """
    if not isinstance(inputs, dict):
        return None

    # Try all known positions for the second positional arg.
    # Weave's JS SDK can't introspect function param names like the Python
    # SDK does, so it falls back to `arg0`, `arg1`, `arg2`, ... for positional
    # args. That's the shape we actually see in production — the named keys
    # below are included for forward-compat if Weave ever gains JS param
    # introspection.
    candidates = []
    for key in ("arg1", "queryStr", "query", "q", "1", 1):
        if key in inputs:
            candidates.append(inputs[key])

    # args-array shape
    args = inputs.get("args")
    if isinstance(args, list) and len(args) >= 2:
        candidates.append(args[1])

    # Fallback: heuristic — any string value in inputs that isn't huge
    # (the state dict serialises to thousands of chars; query is typically
    # <200). Pick the shortest string candidate.
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="STARmem", help="Weave project name")
    parser.add_argument("--entity", default=None, help="Weave entity (defaults to your login)")
    parser.add_argument("--op", default="ladder", help="Op name to filter on")
    parser.add_argument("--limit", type=int, default=500, help="Max calls to fetch")
    parser.add_argument("--top", type=int, default=5, help="Top-N outliers per side")
    parser.add_argument("--since-hours", type=float, default=24, help="Only calls newer than this many hours")
    parser.add_argument("--json", action="store_true", help="Dump raw calls as JSONL instead of markdown")
    parser.add_argument("--debug", action="store_true", help="Dump first call's raw inputs/output for schema inspection")
    args = parser.parse_args()

    project_spec = f"{args.entity}/{args.project}" if args.entity else args.project
    client = weave.init(project_spec)

    since = datetime.now(timezone.utc) - timedelta(hours=args.since_hours)

    # Weave's op_names filter wants full URIs like
    # `weave:///{entity}/{project}/op/{name}:{digest}`, not bare names.
    # Passing "ladder" matches zero rows on the server. Work around by
    # fetching all recent calls and filtering client-side on op_name.
    calls_iter = client.get_calls(limit=args.limit)
    all_calls = list(calls_iter)

    def _op_bare_name(c) -> str:
        """Extract bare op name from a Call. Weave stores it in various
        shapes across versions — op_name (URI), _op_name (bare), or
        inferred from display_name. Be generous in what we accept."""
        raw = getattr(c, "op_name", None) or getattr(c, "_op_name", None) or ""
        if not raw:
            return getattr(c, "display_name", "") or ""
        # URIs end with `/op/{name}:{digest}` — strip to bare name.
        if "/op/" in raw:
            tail = raw.split("/op/", 1)[1]
            return tail.split(":", 1)[0]
        return raw

    calls = [c for c in all_calls if _op_bare_name(c) == args.op]
    all_op_names = Counter(_op_bare_name(c) for c in all_calls)

    # Filter by time client-side (the server filter is finicky across versions)
    calls = [
        c for c in calls
        if c.started_at and c.started_at.replace(tzinfo=timezone.utc) >= since
    ]

    if not calls:
        print(f"# No `{args.op}` calls found in the last {args.since_hours}h.")
        print()
        print(f"Checked project: {project_spec}")
        print(f"Total calls fetched (any op): {len(all_calls)}")
        if all_op_names:
            print(f"Op names seen: {dict(all_op_names)}")
        print("If you expected traces, verify:")
        print(f"  - Recent run actually called initWeave('{args.project}')")
        print(f"  - ~/.netrc has a machine api.wandb.ai entry")
        print(f"  - Op name '{args.op}' matches one of the above")
        return

    if args.debug and calls:
        c0 = calls[0]
        print("# DEBUG — first call structure")
        print()
        print(f"op_name: {getattr(c0, 'op_name', None)}")
        print(f"display_name: {getattr(c0, 'display_name', None)}")
        print()
        print("## inputs keys and types")
        if isinstance(c0.inputs, dict):
            for k, v in c0.inputs.items():
                vtype = type(v).__name__
                preview = repr(v)[:120]
                print(f"  - `{k}` ({vtype}): {preview}")
        else:
            print(f"  inputs is not a dict: {type(c0.inputs).__name__}")
        print()
        print("## output keys")
        if isinstance(c0.output, dict):
            for k, v in c0.output.items():
                vtype = type(v).__name__
                preview = repr(v)[:80]
                print(f"  - `{k}` ({vtype}): {preview}")
        else:
            print(f"  output is not a dict: {type(c0.output).__name__}")
        return

    if args.json:
        for c in calls:
            payload = {
                "id": str(c.id),
                "started_at": c.started_at.isoformat() if c.started_at else None,
                "ended_at": c.ended_at.isoformat() if c.ended_at else None,
                "inputs_query": extract_query(c.inputs),
                "tier": extract_tier(c.output),
            }
            print(json.dumps(payload))
        return

    # Enrich with latency + extracted fields
    rows = []
    for c in calls:
        if not (c.started_at and c.ended_at):
            continue
        lat_ms = (c.ended_at - c.started_at).total_seconds() * 1000.0
        rows.append({
            "lat_ms": lat_ms,
            "tier": extract_tier(c.output),
            "query": extract_query(c.inputs),
            "id": str(c.id),
        })

    rows.sort(key=lambda r: r["lat_ms"])

    # ----- Report -----
    latencies = [r["lat_ms"] for r in rows]
    tiers = [r["tier"] for r in rows]

    print(f"# Trace analysis — {len(rows)} `{args.op}` calls")
    print()
    print(f"Project: `{project_spec}` · window: last {args.since_hours}h · generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print()

    print("## Latency (ms)")
    print()
    q = statistics.quantiles(latencies, n=100) if len(latencies) >= 2 else [latencies[0]] * 99
    print(f"- **p50**: {statistics.median(latencies):.2f}")
    print(f"- **p95**: {q[94]:.2f}")
    print(f"- **p99**: {q[98]:.2f}")
    print(f"- **min**: {min(latencies):.2f}")
    print(f"- **max**: {max(latencies):.2f}")
    print(f"- **mean**: {statistics.mean(latencies):.2f} ± {statistics.stdev(latencies):.2f}")
    print()

    print("## Tier distribution")
    print()
    dist = Counter(tiers)
    for tier, count in dist.most_common():
        pct = 100 * count / len(rows)
        print(f"- Tier `{tier}`: {count} ({pct:.1f}%)")
    print()

    print(f"## Top {args.top} slowest")
    print()
    print("| latency (ms) | tier | query |")
    print("|---|---|---|")
    for r in rows[-args.top:][::-1]:
        print(f"| {r['lat_ms']:.2f} | {r['tier']} | {fmt_query(r['query'])} |")
    print()

    print(f"## Top {args.top} fastest")
    print()
    print("| latency (ms) | tier | query |")
    print("|---|---|---|")
    for r in rows[: args.top]:
        print(f"| {r['lat_ms']:.2f} | {r['tier']} | {fmt_query(r['query'])} |")
    print()

    # Query-length × latency sanity check — are slow queries just longer?
    with_q = [r for r in rows if r["query"]]
    if len(with_q) >= 10:
        lengths = [len(r["query"]) for r in with_q]
        lats = [r["lat_ms"] for r in with_q]
        # Pearson correlation without numpy
        n = len(lengths)
        mx, my = statistics.mean(lengths), statistics.mean(lats)
        num = sum((lengths[i] - mx) * (lats[i] - my) for i in range(n))
        den_x = sum((lengths[i] - mx) ** 2 for i in range(n)) ** 0.5
        den_y = sum((lats[i] - my) ** 2 for i in range(n)) ** 0.5
        corr = num / (den_x * den_y) if den_x and den_y else 0.0
        print("## Query length × latency")
        print()
        print(f"- Pearson r = **{corr:+.3f}** across {n} calls")
        if abs(corr) < 0.1:
            print("- Interpretation: no meaningful relationship — longer queries are NOT slower.")
        elif corr > 0.3:
            print("- Interpretation: moderate positive correlation — longer queries tend to be slower.")
        elif corr < -0.3:
            print("- Interpretation: moderate negative correlation — unusual, worth investigating.")
        else:
            print("- Interpretation: weak correlation — query length is a minor factor at best.")
        print()


if __name__ == "__main__":
    main()
