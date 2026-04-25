"""Modal vLLM offline-batch warmup for STARmem extraction cache.

Reads enumerated WarmupBatch entries (one per JSONL line) from
/data/warmup-input.jsonl on the starmem-bench-data Volume, runs vLLM
offline batch on a single H100, and writes per-customId cache files to
/data/extractions/<customId>.json in the byte-compat format the existing
extractionCache.js read path expects.

Byte-compat contract (matches bench/harness/extractionCache.js wrapWithCache):
    - filename: ${customId}.json under /data/extractions/
    - content: JSON.stringify({model, maxTokens, response, at}, null, 2)
      Python json.dumps(..., indent=2) matches Node's insertion-order
      shape AS LONG AS the dict is built in the same key order:
      {"model": ..., "maxTokens": ..., "response": ..., "at": ...}.

Run from repo root on the host:
    # 1. Enumerate (no API calls):
    node bench/harness/fireworks-warmup.js enumerate /tmp/warmup-input.jsonl \\
        --corpora locomo,longmemeval-s

    # 2. Upload to Volume:
    modal volume put starmem-bench-data /tmp/warmup-input.jsonl /warmup-input.jsonl

    # 3. Dispatch (or smoke first; see Task 4):
    modal run bench/modal/vllm_warmup.py::main

    # 4. Regression check (Task 6):
    modal run bench/modal/sweep_app.py::main --mode run-longmemeval-warmup \\
        --corpus-size 3 --warmup-concurrency 1
    # -> expect misses=0 on all 3.

@module bench/modal/vllm_warmup
@see docs/plans/phase-12-task-6-5-modal-vllm-warmup.md Task 2
"""

import json
import os
import time
from typing import Optional

import modal


app = modal.App("starmem-bench-vllm-warmup")

# Standalone image -- does NOT share the starmem-bench app's image.
# vLLM is heavy (~few GB) and we do not want every benchmark container
# loading it. Kept minimal: vllm (NIGHTLY -- Qwen3.6 has open bugs in
# 0.19.0 stable on reasoning/tool-call paths that affect our
# --reasoning-parser qwen3 fallback) + huggingface_hub for the model
# snapshot.
#
# Nightly install via Modal's pip_install with extra_index_url + pre=True.
# If a future nightly regresses our smoke (Task 4), pin to the last
# known-good dated nightly via `pip_install("vllm==0.X.Y.devNNN", ...)`
# rather than rolling back to 0.19.0 stable -- see Decision 10.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "vllm",
        "huggingface_hub>=0.24",
        pre=True,
        extra_index_url="https://wheels.vllm.ai/nightly",
    )
)

# Same Volume as sweep_app.py -- mounted at /data, with /data/extractions
# being the canonical cache directory (symlinked into the repo at
# bench/.cache/extractions by _install_volume_symlink in sweep_app.py).
volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)


# ============================================================
# Helpers (bare functions; only the dispatch fn gets @app.function)
# ============================================================


def _read_jsonl(path: str) -> list:
    """Read JSONL -> list of dicts. One pass; tolerates trailing newline."""
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _strip_reasoning(text: str) -> str:
    """Belt-and-suspenders: if vLLM leaks a <think>...</think> block
    despite enable_thinking=False, strip it before writing cache.

    Downstream parseLLMJson() in src/consolidation/extractFacts.js can't
    handle reasoning-channel preamble; it expects raw JSON or markdown-
    fenced JSON. Cache must be parseable.
    """
    if not text.startswith("<think>"):
        return text
    end = text.find("</think>")
    if end == -1:
        return text  # malformed -- let downstream surface the issue
    after = text[end + len("</think>"):]
    return after.lstrip()


def _write_cache_file(
    cache_dir: str, custom_id: str, model: str, max_tokens: int, response: str
) -> None:
    """Write byte-compat cache file at <cache_dir>/<custom_id>.json.

    Format MUST match bench/harness/extractionCache.js wrapWithCache:
        JSON.stringify({model, maxTokens, response, at}, null, 2)

    Python json.dumps with indent=2 matches Node's pretty-print 2-space
    indentation. Key insertion order is preserved by Python 3.7+ dicts;
    we build the dict in the same order Node uses.
    """
    payload = {
        "model": model,
        "maxTokens": max_tokens,
        "response": response,
        "at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    path = os.path.join(cache_dir, f"{custom_id}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


# ============================================================
# Dispatch -- single H100, one LLM.chat() call, no fan-out
# ============================================================


@app.function(
    image=image,
    volumes={"/data": volume},
    gpu="H100",
    timeout=5400,  # 90 min -- covers worst-case ~72 min + headroom
    memory=32768,
)
def warmup(
    input_path: str = "/data/warmup-input.jsonl",
    cache_dir: str = "/data/extractions",
    model: str = "Qwen/Qwen3.6-35B-A3B-FP8",
    max_tokens_override: Optional[int] = None,
    skip_existing: bool = True,
) -> dict:
    """Run vLLM offline batch over enumerated WarmupBatch JSONL.

    Args:
        input_path: Volume path to JSONL of {customId, model, messages,
            maxTokens, itemId, batchIdxInItem} per line.
        cache_dir: Volume path to write <customId>.json files.
        model: vLLM model id. Pinned default to keep the cache key stable
            across reruns.
        max_tokens_override: If set, overrides per-row maxTokens. Useful
            for smoke runs that want to ensure non-empty content; do NOT
            use for the full dispatch (would change the cache key).
        skip_existing: If True (default), check os.path.exists before
            dispatching each batch -- rerun-safe by construction.

    Returns:
        Dict with totalRows, dispatched, skippedExisting, written,
        perPromptFailures, firstError, wallSeconds, sustainedOutTokPerS.
    """
    from vllm import LLM, SamplingParams

    os.makedirs(cache_dir, exist_ok=True)

    rows = _read_jsonl(input_path)
    total_rows = len(rows)
    if total_rows == 0:
        return {
            "totalRows": 0,
            "dispatched": 0,
            "skippedExisting": 0,
            "written": 0,
            "perPromptFailures": 0,
            "firstError": None,
            "wallSeconds": 0,
            "sustainedOutTokPerS": 0.0,
            "note": "empty input -- nothing to do",
        }

    # Build dispatch list, skipping existing cache files.
    dispatch: list = []
    skipped_existing = 0
    for row in rows:
        custom_id = row["customId"]
        cache_path = os.path.join(cache_dir, f"{custom_id}.json")
        if skip_existing and os.path.exists(cache_path):
            skipped_existing += 1
            continue
        dispatch.append(row)

    if not dispatch:
        return {
            "totalRows": total_rows,
            "dispatched": 0,
            "skippedExisting": skipped_existing,
            "written": 0,
            "perPromptFailures": 0,
            "firstError": None,
            "wallSeconds": 0,
            "sustainedOutTokPerS": 0.0,
            "note": "all rows already cached -- nothing to do",
        }

    # Sampling -- Instruct (non-thinking) preset from the model card.
    # max_tokens defaults to row's maxTokens (uniform across all rows
    # produced by enumerateWarmupBatches); fall back to a 2048 floor only
    # if a row is missing the field. Belt-and-suspenders override path is
    # the max_tokens_override kwarg.
    first_max = max_tokens_override or dispatch[0].get("maxTokens", 2048)
    sampling = SamplingParams(
        max_tokens=first_max,
        temperature=0.0,                 # deterministic -- extraction
        top_p=1.0,
        # presence_penalty / repetition_penalty intentionally OMITTED
        # from defaults: extraction prompts are JSON-shaped; the model
        # card's instruct-mode preset (presence_penalty=1.5) is for free-
        # form generation and would distort JSON token distributions.
    )

    # Initialize the engine. language_model_only skips the vision encoder;
    # gpu_memory_utilization=0.92 leaves headroom for KV cache spike.
    # max_model_len capped at 8192 -- extraction prompts are ~1.2K in,
    # ~400 out, so 8K is comfortable and frees memory for larger batches.
    llm = LLM(
        model=model,
        dtype="auto",
        trust_remote_code=False,
        language_model_only=True,
        gpu_memory_utilization=0.92,
        max_model_len=8192,
        enforce_eager=False,
    )

    # Build messages_list parallel to dispatch (NEVER rely on positional
    # ordering of vLLM outputs -- zip via index always).
    messages_list = [row["messages"] for row in dispatch]

    t_start = time.monotonic()
    outputs = llm.chat(
        messages_list,
        sampling_params=sampling,
        chat_template_kwargs={"enable_thinking": False},
        use_tqdm=False,  # stdout would flood Modal logs
    )
    wall_seconds = time.monotonic() - t_start

    # Per-prompt validation + cache write. Honest aggregation: each
    # prompt is success or failure independently; surface a firstError
    # at the top level for fast triage.
    written = 0
    failures = 0
    first_error: Optional[dict] = None
    total_out_tokens = 0

    for idx, output in enumerate(outputs):
        row = dispatch[idx]
        custom_id = row["customId"]
        try:
            if not output.outputs:
                raise ValueError("vLLM returned no outputs[] for this prompt")
            text_raw = output.outputs[0].text or ""
            text = _strip_reasoning(text_raw)
            if not text.strip():
                raise ValueError(
                    f"empty content (len(raw)={len(text_raw)}, len(stripped)={len(text)}) -- "
                    "reasoning-budget exhaustion or chat-template leak"
                )
            total_out_tokens += len(output.outputs[0].token_ids or [])
            _write_cache_file(
                cache_dir,
                custom_id,
                model,
                row.get("maxTokens", first_max),
                text,
            )
            written += 1
        except Exception as exc:
            failures += 1
            if first_error is None:
                first_error = {
                    "customId": custom_id,
                    "itemId": row.get("itemId"),
                    "batchIdxInItem": row.get("batchIdxInItem"),
                    "errorType": type(exc).__name__,
                    "errorMessage": str(exc)[:500],
                }

    # CRITICAL: commit the volume so cache files survive container teardown.
    volume.commit()

    sustained = (total_out_tokens / wall_seconds) if wall_seconds > 0 else 0.0

    return {
        "totalRows": total_rows,
        "dispatched": len(dispatch),
        "skippedExisting": skipped_existing,
        "written": written,
        "perPromptFailures": failures,
        "firstError": first_error,
        "wallSeconds": round(wall_seconds, 2),
        "sustainedOutTokPerS": round(sustained, 1),
        "totalOutTokens": total_out_tokens,
        "model": model,
    }


@app.local_entrypoint()
def main(
    input_path: str = "/data/warmup-input.jsonl",
    cache_dir: str = "/data/extractions",
    model: str = "Qwen/Qwen3.6-35B-A3B-FP8",
    max_tokens_override: Optional[int] = None,
    skip_existing: bool = True,
):
    """Local entrypoint -- invoke `modal run bench/modal/vllm_warmup.py`.

    Prints the result as JSON for easy log-paste into the controller.
    """
    result = warmup.remote(
        input_path=input_path,
        cache_dir=cache_dir,
        model=model,
        max_tokens_override=max_tokens_override,
        skip_existing=skip_existing,
    )
    print(json.dumps(result, indent=2))

    # Exit code != 0 if any per-prompt failures, so a smoke run with
    # silent reasoning-budget exhaustion fails the controller's
    # `modal run` check rather than silently shipping bad cache.
    if result.get("perPromptFailures", 0) > 0:
        raise SystemExit(1)
