"""Upload STARmem bench cache files to the Modal Volume.

Usage:
    modal run bench/modal/upload_cache.py

Expects to find:
    bench/.cache/locomo10.json   → /data/locomo10.json
    bench/.cache/extractions/    → /data/extractions/
"""

import modal
import os
import json

app = modal.App("starmem-bench-upload")
volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)

@app.function(volumes={"/data": volume}, timeout=300)
def upload():
    import shutil
    repo_root = "/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem"
    src_corpus = os.path.join(repo_root, "bench", ".cache", "locomo10.json")
    src_cache = os.path.join(repo_root, "bench", ".cache", "extractions")
    dst_corpus = "/data/locomo10.json"
    dst_cache = "/data/extractions"

    if not os.path.exists(src_corpus):
        raise FileNotFoundError(f"Corpus cache not found: {src_corpus}")
    if not os.path.exists(src_cache):
        raise FileNotFoundError(f"Extraction cache not found: {src_cache}")

    shutil.copy2(src_corpus, dst_corpus)
    if os.path.exists(dst_cache):
        shutil.rmtree(dst_cache)
    shutil.copytree(src_cache, dst_cache)

    # Verify
    corpus_size = os.path.getsize(dst_corpus)
    cache_files = sum(1 for _root, _dirs, files in os.walk(dst_cache) for _ in files)
    return {
        "corpus": dst_corpus,
        "corpusSizeBytes": corpus_size,
        "cacheDir": dst_cache,
        "cacheFiles": cache_files,
    }


@app.local_entrypoint()
def main():
    result = upload.remote()
    print(json.dumps(result, indent=2))
