#!/usr/bin/env python3
"""Render a social card (template.html + JSON data) to a square PNG via headless Chrome.

Usage:
    python3 render.py data.json out.png [--template template.html] [--size 1080] [--scale 2]

The JSON is injected into the template (replacing __DATA__) and Chrome screenshots
it at size*scale px square (default 2160x2160 -> crisp, downscales nicely for social).
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = Path(__file__).parent


def parse_args(argv):
    pos, opts = [], {"size": 1080, "scale": 2, "template": "template.html"}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--size":
            opts["size"] = int(argv[i + 1]); i += 2
        elif a == "--scale":
            opts["scale"] = float(argv[i + 1]); i += 2
        elif a == "--template":
            opts["template"] = argv[i + 1]; i += 2
        else:
            pos.append(a); i += 1
    return pos, opts


def main():
    pos, opts = parse_args(sys.argv[1:])
    if len(pos) < 2:
        sys.exit("usage: render.py data.json out.png [--size 1080] [--scale 2]")
    data_path, out_path = Path(pos[0]), Path(pos[1])

    data = json.loads(data_path.read_text(encoding="utf-8"))
    template = HERE / opts["template"]
    html = template.read_text(encoding="utf-8").replace(
        "__DATA__", json.dumps(data, ensure_ascii=False)
    )

    out_path = out_path.resolve()
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, dir=HERE) as f:
        f.write(html)
        tmp = Path(f.name)

    try:
        cmd = [
            CHROME,
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-sandbox",
            f"--force-device-scale-factor={opts['scale']}",
            f"--window-size={opts['size']},{opts['size']}",
            "--virtual-time-budget=5000",
            "--run-all-compositor-stages-before-draw",
            f"--screenshot={out_path}",
            tmp.as_uri(),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if not out_path.exists():
            sys.exit(f"render failed:\n{r.stderr}")
    finally:
        tmp.unlink(missing_ok=True)

    px = int(opts["size"] * opts["scale"])
    print(f"OK -> {out_path} ({px}x{px})")


if __name__ == "__main__":
    main()
