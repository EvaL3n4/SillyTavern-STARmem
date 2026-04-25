"""Unit tests for bench/modal/vllm_warmup.py.

Tests the pure helpers directly + tests warmup() with vLLM LLM mocked.
Does NOT run vLLM -- that's smoke-territory (Task 4).
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# Make sure the bench/modal package is importable in test context.
REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture
def tmp_cache(tmp_path: Path) -> Path:
    """Disposable cache directory."""
    d = tmp_path / "extractions"
    d.mkdir()
    return d


@pytest.fixture
def tmp_input(tmp_path: Path):
    """Build a JSONL input file from a list of dicts."""
    def _build(rows: list) -> Path:
        p = tmp_path / "warmup-input.jsonl"
        p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
        return p
    return _build


# ============================================================
# Pure helpers
# ============================================================


def test_strip_reasoning_passthrough_when_no_think_block():
    from bench.modal.vllm_warmup import _strip_reasoning
    assert _strip_reasoning('{"entries": []}') == '{"entries": []}'
    assert _strip_reasoning("plain text") == "plain text"


def test_strip_reasoning_strips_well_formed_think_block():
    from bench.modal.vllm_warmup import _strip_reasoning
    raw = "<think>I should extract facts.</think>\n\n{\"entries\": [{\"text\": \"hi\"}]}"
    assert _strip_reasoning(raw) == '{"entries": [{"text": "hi"}]}'


def test_strip_reasoning_passthrough_on_malformed_think():
    from bench.modal.vllm_warmup import _strip_reasoning
    raw = "<think>unfinished"
    # Don't damage malformed input -- let downstream surface the issue.
    assert _strip_reasoning(raw) == raw


def test_read_jsonl_tolerates_blank_lines_and_trailing_newline(tmp_path):
    from bench.modal.vllm_warmup import _read_jsonl
    p = tmp_path / "x.jsonl"
    p.write_text('{"a": 1}\n\n{"a": 2}\n')
    assert _read_jsonl(str(p)) == [{"a": 1}, {"a": 2}]


# ============================================================
# Byte-compat -- write a cache file, read it via Node extractionCache.js
# ============================================================


def test_write_cache_file_byte_compat_with_node_read(tmp_cache):
    """The Node read path (wrapWithCache) must accept files we write.

    This is the load-bearing invariant of the entire substrate swap.
    If this test fails, every Modal vLLM warmup will produce cache that
    the regression check (Task 6) cannot read, and we MUST stop.
    """
    from bench.modal.vllm_warmup import _write_cache_file

    custom_id = "deadbeef" * 8  # 64 hex chars
    model = "Qwen/Qwen3.6-35B-A3B-FP8"
    max_tokens = 2048
    response = '{"entries": [{"text": "Eva likes cherry blossoms."}]}'

    _write_cache_file(str(tmp_cache), custom_id, model, max_tokens, response)

    cache_file = tmp_cache / f"{custom_id}.json"
    assert cache_file.exists()

    parsed = json.loads(cache_file.read_text())
    assert parsed["model"] == model
    assert parsed["maxTokens"] == max_tokens
    assert parsed["response"] == response
    assert "at" in parsed
    # Top-level keys MUST appear in this exact order to match Node's
    # JSON.stringify({model, maxTokens, response, at}, null, 2). Python
    # json.dumps preserves insertion order in 3.7+.
    keys = list(parsed.keys())
    assert keys == ["model", "maxTokens", "response", "at"], (
        f"key order drift: {keys} -- must match Node's stringify shape"
    )

    # Round-trip via Node: read the file directly and parse, confirming
    # the bytes we wrote are valid JSON the Node side accepts. We bypass
    # wrapWithCache's _cacheKey lookup (we already know the customId)
    # and just prove the file round-trips through Node's JSON parser.
    if subprocess.run(["which", "node"], capture_output=True).returncode != 0:
        pytest.skip("node not available in test environment")

    node_script = (
        "const fs = await import('node:fs/promises');\n"
        f"const raw = await fs.readFile({json.dumps(str(cache_file))}, 'utf8');\n"
        "const parsed = JSON.parse(raw);\n"
        "if (typeof parsed.response !== 'string') {\n"
        "    console.error('parse fail');\n"
        "    process.exit(2);\n"
        "}\n"
        "process.stdout.write(parsed.response);\n"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", node_script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, f"node read failed: {result.stderr}"
    assert result.stdout == response


# ============================================================
# Mocked warmup() -- scrambled order, empty content, skip-existing
# ============================================================


def _mock_vllm_output(text: str, token_ids: list = None):
    """Build a MagicMock that quacks like vllm RequestOutput."""
    inner = MagicMock()
    inner.text = text
    inner.token_ids = token_ids or list(range(len(text)))
    out = MagicMock()
    out.outputs = [inner]
    return out


def _resolve_warmup_callable(mod):
    """Modal's @app.function decorator may wrap the function; we want
    the underlying Python callable for unit testing. The conftest stub
    pattern from Phase 11 keeps the function plain-callable, but be
    defensive in case the stub shape evolves.
    """
    fn = mod.warmup
    # Try common unwrap attributes in order of likelihood.
    for attr in ("__wrapped__", "_callable", "local"):
        candidate = getattr(fn, attr, None)
        if callable(candidate) and not hasattr(candidate, "remote"):
            return candidate
    # Last resort: assume the stub keeps it directly callable.
    return fn


def test_warmup_zips_outputs_to_dispatch_by_index(tmp_path, tmp_cache, tmp_input):
    """Outputs are zipped to dispatch[idx], NEVER positional ordering of
    raw vLLM outputs. Even if vLLM returned a list shuffled relative to
    our intent, the loop pulls custom_id from dispatch[idx], so writes
    are correct iff we obey input order on the input side.
    """
    rows = [
        {"customId": "a" * 64, "model": "M", "messages": [{"role": "user", "content": "1"}], "maxTokens": 100, "itemId": "i1", "batchIdxInItem": 0},
        {"customId": "b" * 64, "model": "M", "messages": [{"role": "user", "content": "2"}], "maxTokens": 100, "itemId": "i1", "batchIdxInItem": 1},
        {"customId": "c" * 64, "model": "M", "messages": [{"role": "user", "content": "3"}], "maxTokens": 100, "itemId": "i2", "batchIdxInItem": 0},
    ]
    inp = tmp_input(rows)

    fake_outputs = [
        _mock_vllm_output('{"entries": [{"t": "one"}]}'),
        _mock_vllm_output('{"entries": [{"t": "two"}]}'),
        _mock_vllm_output('{"entries": [{"t": "three"}]}'),
    ]

    fake_llm = MagicMock()
    fake_llm.chat.return_value = fake_outputs

    fake_vllm = MagicMock()
    fake_vllm.LLM = MagicMock(return_value=fake_llm)
    fake_vllm.SamplingParams = MagicMock()

    from bench.modal import vllm_warmup as mod
    # Modal stubs: volume.commit() must be a no-op no-arg callable.
    mod.volume = MagicMock()
    target_fn = _resolve_warmup_callable(mod)

    with patch.dict(sys.modules, {"vllm": fake_vllm}):
        result = target_fn(
            input_path=str(inp),
            cache_dir=str(tmp_cache),
            model="M",
        )

    assert result["written"] == 3
    assert result["perPromptFailures"] == 0
    # Each row's customId got a file with the matching response.
    a = json.loads((tmp_cache / f"{'a' * 64}.json").read_text())
    b = json.loads((tmp_cache / f"{'b' * 64}.json").read_text())
    c = json.loads((tmp_cache / f"{'c' * 64}.json").read_text())
    assert "one" in a["response"]
    assert "two" in b["response"]
    assert "three" in c["response"]


def test_warmup_treats_empty_content_as_per_prompt_failure(tmp_path, tmp_cache, tmp_input):
    """Reasoning-budget exhaustion -> empty content -> per-prompt failure.

    Mirrors batch-api-cache-warmup skill's reasoning-model-trap. The
    smoke spot-check (Task 4) catches this in production; the unit test
    catches the regression risk on every CI run.
    """
    rows = [
        {"customId": "f" * 64, "model": "M", "messages": [{"role": "user", "content": "1"}], "maxTokens": 100, "itemId": "i1", "batchIdxInItem": 0},
    ]
    inp = tmp_input(rows)

    fake_outputs = [_mock_vllm_output("")]  # empty content
    fake_llm = MagicMock()
    fake_llm.chat.return_value = fake_outputs
    fake_vllm = MagicMock()
    fake_vllm.LLM = MagicMock(return_value=fake_llm)
    fake_vllm.SamplingParams = MagicMock()

    from bench.modal import vllm_warmup as mod
    mod.volume = MagicMock()
    target_fn = _resolve_warmup_callable(mod)

    with patch.dict(sys.modules, {"vllm": fake_vllm}):
        result = target_fn(input_path=str(inp), cache_dir=str(tmp_cache), model="M")

    assert result["written"] == 0
    assert result["perPromptFailures"] == 1
    assert result["firstError"] is not None
    assert "empty content" in result["firstError"]["errorMessage"]


def test_warmup_skip_existing_short_circuits(tmp_path, tmp_cache, tmp_input):
    """skip_existing=True must NOT call vLLM at all if every row is cached."""
    rows = [
        {"customId": "1" * 64, "model": "M", "messages": [{"role": "user", "content": "x"}], "maxTokens": 100, "itemId": "i", "batchIdxInItem": 0},
    ]
    inp = tmp_input(rows)

    # Pre-populate the cache.
    (tmp_cache / f"{'1' * 64}.json").write_text(json.dumps(
        {"model": "M", "maxTokens": 100, "response": "{}", "at": "2026-04-25T00:00:00.000Z"},
        indent=2,
    ))

    fake_vllm = MagicMock()
    fake_vllm.LLM = MagicMock()  # SHOULD NOT BE CALLED
    fake_vllm.SamplingParams = MagicMock()

    from bench.modal import vllm_warmup as mod
    mod.volume = MagicMock()
    target_fn = _resolve_warmup_callable(mod)

    with patch.dict(sys.modules, {"vllm": fake_vllm}):
        result = target_fn(input_path=str(inp), cache_dir=str(tmp_cache), model="M", skip_existing=True)

    assert result["dispatched"] == 0
    assert result["skippedExisting"] == 1
    assert result["written"] == 0
    fake_vllm.LLM.assert_not_called()


def test_warmup_empty_input_returns_zero(tmp_path, tmp_cache, tmp_input):
    """An empty input file -- e.g. someone enumerated against a corpus
    that filtered down to zero items -- must return cleanly without
    spinning up vLLM. Edge case but important: a smoke run with --limit 0
    should not nonsensically charge for an idle GPU."""
    inp = tmp_input([])
    # Need at least an empty file (the fixture creates one with no lines).

    fake_vllm = MagicMock()
    fake_vllm.LLM = MagicMock()
    fake_vllm.SamplingParams = MagicMock()

    from bench.modal import vllm_warmup as mod
    mod.volume = MagicMock()
    target_fn = _resolve_warmup_callable(mod)

    with patch.dict(sys.modules, {"vllm": fake_vllm}):
        result = target_fn(input_path=str(inp), cache_dir=str(tmp_cache), model="M")

    assert result["totalRows"] == 0
    assert result["written"] == 0
    fake_vllm.LLM.assert_not_called()
