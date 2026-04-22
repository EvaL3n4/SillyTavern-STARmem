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


@app.local_entrypoint()
def main(mode: str = "hello", overrides_json: str = "{}"):
    """Dispatch entrypoint for Modal bench functions.

    Usage:
        modal run bench/modal/sweep_app.py
            → runs hello() and prints nodeVersion + volume mount check

        modal run bench/modal/sweep_app.py --mode run-point --overrides-json '{}'
            → runs run_point() with empty overrides

        modal run bench/modal/sweep_app.py --mode run-point --overrides-json '{"TIER2_TAU_CONFIDENCE": 0.5}'
            → runs run_point() with one override
    """
    if mode == "hello":
        print(json.dumps(hello.remote(), indent=2))
    elif mode == "run-point":
        print(run_point.remote(overrides_json))
    else:
        print(f"Unknown mode: {mode!r}. Expected 'hello' or 'run-point'.")
