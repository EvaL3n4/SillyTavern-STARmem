import modal
import json

app = modal.App("starmem-bench")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .run_commands(
        "apt-get update && apt-get install -y curl ca-certificates",
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
    )
    .add_local_dir(
        "/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem",
        "/repo",
    )
)

volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)

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

@app.function(image=image, volumes={"/data": volume}, timeout=600, memory=4096)
def run_point(overrides_json: str) -> str:
    """Run a single sweep point.

    Args:
        overrides_json: JSON string of Record<string, number> overrides.

    Returns:
        JSON string with { overrides, metrics, latencyMs, runCount, wallMs }.
    """
    import os
    import subprocess

    # Symlink Volume cache to where the repo expects it
    repo_cache = "/repo/bench/.cache"
    os.makedirs(repo_cache, exist_ok=True)
    corpus_link = os.path.join(repo_cache, "locomo10.json")
    cache_link = os.path.join(repo_cache, "extractions")
    if not os.path.exists(corpus_link):
        os.symlink("/data/locomo10.json", corpus_link)
    if not os.path.exists(cache_link):
        os.symlink("/data/extractions", cache_link)

    env = os.environ.copy()
    env["STARMEM_OVERRIDES"] = overrides_json

    result = subprocess.run(
        ["node", "bench/sweeps/_modal-point.js"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=True,
        env=env,
    )
    return result.stdout.strip()


@app.local_entrypoint()
def main():
    print(json.dumps(hello.remote(), indent=2))
