"""Verify STARmem bench cache files on the Modal Volume.

The Volume is populated via Modal CLI, NOT from inside a function
(Modal containers can't see the controller's filesystem). Run these
commands from the repo root on the host shell:

    modal volume put starmem-bench-data bench/.cache/locomo10.json /locomo10.json
    modal volume put starmem-bench-data bench/.cache/extractions /extractions

Then run this script to verify what landed:

    modal run bench/modal/upload_cache.py
"""

import modal
import json
import os

app = modal.App("starmem-bench-upload")
volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)


@app.function(volumes={"/data": volume}, timeout=120)
def verify():
    """Inspect the Volume contents and return stats."""
    corpus_path = "/data/locomo10.json"
    cache_path = "/data/extractions"

    corpus_exists = os.path.exists(corpus_path)
    cache_exists = os.path.exists(cache_path)

    corpus_size = os.path.getsize(corpus_path) if corpus_exists else 0
    cache_file_count = 0
    cache_size = 0
    if cache_exists:
        for root, _dirs, files in os.walk(cache_path):
            for f in files:
                cache_file_count += 1
                try:
                    cache_size += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass

    return {
        "corpusPath": corpus_path,
        "corpusExists": corpus_exists,
        "corpusSizeBytes": corpus_size,
        "cacheDir": cache_path,
        "cacheExists": cache_exists,
        "cacheFiles": cache_file_count,
        "cacheSizeBytes": cache_size,
    }


@app.local_entrypoint()
def main():
    result = verify.remote()
    print(json.dumps(result, indent=2))
    if not result["corpusExists"] or not result["cacheExists"]:
        print()
        print("One or both paths missing. Run from repo root on the host:")
        print("  modal volume put starmem-bench-data bench/.cache/locomo10.json /locomo10.json")
        print("  modal volume put starmem-bench-data bench/.cache/extractions /extractions")
        print()
        print("Then re-run: modal run bench/modal/upload_cache.py")
