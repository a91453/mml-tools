"""Package the reviewed merged Studio bytes; never rebuild from this ops branch."""
import hashlib
import json
import pathlib
import subprocess
import sys
import zipfile

SOURCE_SHA = "45c5a2963b1e2e55fb6d28cf21aeb6af2f6e7614"
BUILD_ID = "dd273beedc0ce16485bd837cf6074171d63eda262fe0b4599f312961ca3b9e97"
CACHE_ID = "c76deb21ba7848c261d6c1f7100e95fe4ac7874c3b4e4f6f05c61b04c1b8a05f"
TRUSTED = ["scripts/verify-studio-artifact.mjs", "scripts/studio-artifact-identity.mjs",
           "studio/web/canonical-contract.mjs", "studio/web/sw.js"]
TAG = "studio-v1-durable-45c5a2963b1e"

def digest(data):
    return hashlib.sha256(data).hexdigest()

def write_zip(path, files):
    # ZIP_STORED avoids compressor/platform drift. Fixed timestamps and modes.
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    return {"filename": path.name, "sha256": digest(path.read_bytes()), "bytes": path.stat().st_size}

def main():
    source, artifact, output = map(lambda x: pathlib.Path(x).resolve(), sys.argv[1:])
    output.mkdir(parents=True, exist_ok=True)
    git = lambda *args: subprocess.check_output(["git", "-C", str(source), *args])
    assert git("rev-parse", "HEAD").decode().strip() == SOURCE_SHA
    build_bytes = (artifact / "build.json").read_bytes()
    build = json.loads(build_bytes)
    assert build["buildId"] == BUILD_ID and build["release"]["cacheId"] == CACHE_ID
    assert build["audit"]["source_sha"] == SOURCE_SHA
    assert build["audit"]["repository_head"] == SOURCE_SHA
    assert build["audit"]["published_main_head"] == SOURCE_SHA
    assert build["audit"]["manifest_commit"] == "c0800845dd8970c2cbd2256bb9d3eb650c5d69e0"
    assert build["release"]["canonical"] == {
        "canonical_version": "2026-09-23-v2", "canonical_status": "PUBLISHED",
        "manifest_version": "2026-09-23-v2-manifest1",
        "rules_snapshot_sha": "1c84c95133990e3882a5770077c3d2d39b1a6b04",
        "machine_delivery_schema": "mabinogi-mobile-mml-studio/machine-delivery@1"}
    files = {p.relative_to(artifact).as_posix(): p.read_bytes() for p in artifact.rglob("*") if p.is_file()}
    expected = dict(build["files"])
    assert set(files) == set(expected) | {"build.json"}
    assert "sw.js" in expected
    assert all(digest(files[name]) == sha for name, sha in expected.items())
    artifact_zip = write_zip(output / f"mml-studio-{BUILD_ID}.zip", files)
    trusted = {name: git("show", f"{SOURCE_SHA}:{name}") for name in TRUSTED}
    trusted_zip = write_zip(output / f"studio-trust-{SOURCE_SHA}.zip", trusted)
    lock = {
        "schema": "studio-durable-release-v1", "repository": "a91453/mml-tools", "tag": TAG,
        "sourceSha": SOURCE_SHA, "buildId": BUILD_ID, "cacheId": CACHE_ID,
        "canonical": build["release"]["canonical"], "manifestCommit": build["audit"]["manifest_commit"],
        "runtimeBundleDigest": build["release"]["runtimeBundleDigest"],
        "buildJsonSha256": digest(build_bytes), "assetCount": len(expected),
        "artifact": artifact_zip,
        "trust": {**trusted_zip, "sourceSha": SOURCE_SHA,
                  "files": {name: digest(data) for name, data in sorted(trusted.items())}},
    }
    for section in (lock["artifact"], lock["trust"]):
        section["objectKey"] = f"releases/{TAG}/{section['sha256']}/{section['filename']}"
    (output / "release-lock.json").write_text(json.dumps(lock, indent=2) + "\n")
    (output / "SHA256SUMS").write_text("".join(f"{digest(p.read_bytes())}  {p.name}\n" for p in sorted(output.iterdir()) if p.name != "SHA256SUMS"))
    print(json.dumps(lock, indent=2))

if __name__ == "__main__":
    main()
