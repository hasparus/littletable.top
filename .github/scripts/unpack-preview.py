"""Unpack only regular preview files into a fresh deployment directory."""

import json
import re
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

archive_file, destination = map(Path, sys.argv[1:])
destination.mkdir()
roots = {"client", "worker"}
total_size = 0

with tarfile.open(archive_file, "r:gz") as archive:
    for index, entry in enumerate(archive):
        name = PurePosixPath(entry.name)
        if (
            not name.parts
            or name.is_absolute()
            or ".." in name.parts
            or "\\" in entry.name
            or (name.parts[0] not in roots and name != PurePosixPath("wrangler.json"))
            or (not entry.isdir() and not entry.isfile())
            or entry.issparse()
        ):
            raise ValueError(f"Unexpected preview archive entry: {entry.name!r}")
        total_size += entry.size
        if total_size > 256 * 1024 * 1024 or index >= 4096:
            raise ValueError("Preview archive is too large")
        if entry.isdir():
            continue
        file = destination.joinpath(*name.parts)
        file.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(entry) as source, file.open("xb") as output:
            shutil.copyfileobj(source, output)

for required in ("client/index.html", "worker/index.js", "wrangler.json"):
    if not (destination / required).is_file():
        raise ValueError(f"Missing preview file: {required}")
metadata = json.loads((destination / "wrangler.json").read_text())
if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", metadata.get("compatibility_date", "")):
    raise ValueError("Invalid preview Worker compatibility date")
