"""Package the reviewed merged Studio bytes; never rebuild from this ops branch."""
import hashlib
import json
import pathlib
import subprocess
import sys
import zipfile

SOURCE_SHA = "44c282f1f32a9ea036c57dfd8239c7509aad0b3e"
BUILD_ID = "072c2cc6033cfc2c795fdf77d8a6fb2692c724048e16217e5025337605cdea9e"
CACHE_ID = "1cea96fa5918ae79b5cd759e331df3a1f303e37ef8d8af2a19e1d6224a7880b2"
TRUSTED = ["scripts/verify-studio-artifact.mjs", "scripts/studio-artifact-identity.mjs",
           "studio/web/canonical-contract.mjs", "studio/web/sw.js"]
TAG = "studio-v1-durable-44c282f1f32a"

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
    assert build["audit"]["manifest_commit"] == "44f3f0082cf5c30328edf1c251398b844488ad0a"
    assert build["release"]["canonical"] == {
        "canonical_version": "2026-09-23-v3", "canonical_status": "PUBLISHED",
        "manifest_version": "2026-09-23-v3-manifest1",
        "rules_snapshot_sha": "ff1a9df054f5ca1ae42571067fc95feb274755ef",
        "machine_delivery_schema": "mabinogi-mobile-mml-studio/machine-delivery@2"}
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
