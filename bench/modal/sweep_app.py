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
    import subprocess
    result = subprocess.run(
        ["node", "--version"],
        cwd="/repo",
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()

@app.local_entrypoint()
def main():
    print("Node version in container:", hello.remote())
