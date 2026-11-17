"""Install the exact upstream revision and channel SDKs into the active venv."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def main():
    if sys.version_info < (3, 11):
        raise SystemExit("Python 3.11 or newer is required.")
    if sys.prefix == sys.base_prefix:
        raise SystemExit("Run this installer using the channel transport virtual environment.")
    manifest = json.loads((Path(__file__).parent / "channels.json").read_text(encoding="utf-8"))
    commit = manifest["upstreamCommit"]
    channels = {
        channel["id"]: channel["dependencies"]
        for channel in manifest["channels"]
        if channel["id"] not in {"weixin", "websocket"}
    }
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel", action="append", choices=sorted(channels))
    requested = parser.parse_args().channel or channels
    package = f"nanobot-ai @ https://github.com/HKUDS/nanobot/archive/{commit}.tar.gz"
    dependencies = sorted({
        dependency
        for name in requested
        for dependency in channels[name]
    })
    environment = {**os.environ, "NANOBOT_SKIP_WEBUI_BUILD": "1"}
    subprocess.run(
        [sys.executable, "-m", "pip", "install", package, *dependencies],
        env=environment,
        check=True,
    )


if __name__ == "__main__":
    main()
