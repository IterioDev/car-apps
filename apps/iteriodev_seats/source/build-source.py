"""Rebuild the upstream Seats source package with the two reviewable UI overlays.
Uses Python standard library and local Git history only. No network or target execution.
"""
from pathlib import Path
import argparse, gzip, hashlib, io, json, subprocess, tarfile
ROOT = Path(__file__).resolve().parent
BASE = "a9361d7522a58b11e9c083727d6365b26563ae82"
BASE_PATH = "apps/iteriodev_seats/iteriodev_seats@1.6.2.tgz"
BASE_SHA = "b6f50a604460ca0420facbc6dee5ec815f8ef841f56d7ddcfb4c6ff048a9b280"

def build(base):
    assert hashlib.sha256(base).hexdigest() == BASE_SHA, "Unexpected base package"
    app = json.loads((ROOT.parent / "app.json").read_text())
    old, new = "iteriodev_seats@1.6.2", "iteriodev_seats@" + app["version"]
    entries = []
    with tarfile.open(fileobj=io.BytesIO(base)) as source:
        for member in source:
            assert member.isfile() and not member.name.startswith("/") and ".." not in member.name.split("/")
            name, data = member.name, source.extractfile(member).read()
            if name == "src/main.js":
                data = (ROOT / name).read_bytes()
            elif name == old + "/renderer/screens.json":
                obj = json.loads(data)
                settings = json.loads((ROOT / "renderer/settings.json").read_text())
                assert settings["name"] == "settings"
                assert [screen["name"] for screen in obj["screens"]] == ["seats", "settings"]
                obj["screens"][1] = settings
                data = (json.dumps(obj, indent=2) + "\n").encode()
            elif name == "mgu-app.json":
                obj = json.loads(data); obj.update(version=app["version"], tree=new)
                data = (json.dumps(obj, indent=2) + "\n").encode()
            elif name in [old + "/package.json", old + "/npm-shrinkwrap.json"]:
                obj = json.loads(data); obj["version"] = app["version"]
                if name.endswith("/package.json"):
                    obj["mguRequires"] = app["requires"]
                data = (json.dumps(obj, indent=2) + "\n").encode()
            if name.startswith(old + "/"):
                name = new + name[len(old):]
            entries.append((name, data, member.mode))
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, data, mode in sorted(entries):
                member = tarfile.TarInfo(name); member.size = len(data); member.mode = mode
                member.uid = member.gid = member.mtime = 0
                archive.addfile(member, io.BytesIO(data))
    return ROOT.parent / (app["id"] + "@" + app["version"] + ".tgz"), output.getvalue()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-package", type=Path, help="Optional local copy of the unchanged upstream source package")
    parser.add_argument("--check", action="store_true", help="Compare without writing")
    args = parser.parse_args()
    base = args.base_package.read_bytes() if args.base_package else subprocess.check_output(
        ["git", "show", BASE + ":" + BASE_PATH], cwd=ROOT)
    target, data = build(base)
    if args.check:
        assert target.read_bytes() == data, "Committed package does not match the source overlays"
    else:
        target.write_bytes(data)
    print(("Verified " if args.check else "Built ") + target.name + " " + hashlib.sha256(data).hexdigest())
