#!/usr/bin/env python3
"""Zip the game for an itch.io HTML upload.

    python3 scripts/package_itch.py          # -> dist/mnemoquarium-web-<version>.zip

itch.io wants a zip with index.html at its root, which is exactly what web/
is. Tests and press images are left out: players do not need them, and the
zip stays small. Standard library only.
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DIST = ROOT / "dist"
SKIP_DIRS = {"tests", "press"}
SKIP_FILES = {".DS_Store"}


def version() -> str:
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return match.group(1) if match else "dev"


def files() -> list[Path]:
    out = []
    for path in sorted(WEB.rglob("*")):
        if not path.is_file() or path.name in SKIP_FILES:
            continue
        rel = path.relative_to(WEB)
        if rel.parts and rel.parts[0] in SKIP_DIRS:
            continue
        out.append(path)
    return out


def main() -> int:
    if not (WEB / "index.html").is_file():
        print("web/index.html is missing", file=sys.stderr)
        return 1
    DIST.mkdir(exist_ok=True)
    target = DIST / f"mnemoquarium-web-{version()}.zip"
    listed = files()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in listed:
            zf.write(path, path.relative_to(WEB).as_posix())
    size = target.stat().st_size / 1024
    print(f"{target.relative_to(ROOT)}  {len(listed)} files  {size:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
