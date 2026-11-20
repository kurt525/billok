#!/usr/bin/env python3
"""BillOK 8.9: backup/verify/isolated restore drill; never touches unrelated volumes.

Backup reads only a running, labeled BillOK application and its distinct,
labeled PostgreSQL and uploads volumes. Drill creates NEW disposable volumes
and a localhost-inaccessible PostgreSQL container, removing only its own
resources. Production restoration is deliberately NOT implemented.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

PG_PATH = "/var/lib/postgresql/data"
UPLOAD_PATH = "/app/uploads"
PG_IMAGE = "postgres:16-alpine"


def docker(*argv, check=True, **kw):
    return subprocess.run(["docker", *map(str, argv)], check=check, **kw)


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def inspect_container(name):
    app=json.loads(docker("inspect",name,capture_output=True,text=True).stdout)[0]
    labels=app.get("Config",{}).get("Labels") or {}
    if (labels.get("ru.billok.project"),labels.get("ru.billok.component")) != ("billok","application"):
        raise ValueError("Container is not a labeled BillOK application")
    if not app.get("State",{}).get("Running",False):
        raise ValueError("BillOK application not running")
    mounts={m.get("Destination"):m for m in app.get("Mounts",[])}
    m=mounts.get(UPLOAD_PATH)
    if not m or m.get("Type")!="volume" or m.get("Name")!="billok_uploads":
        raise ValueError("Missing BillOK uploads volume")
    meta=json.loads(docker("volume","inspect","billok_uploads",capture_output=True,text=True).stdout)[0]
    lab=meta.get("Labels") or {}
    if (lab.get("ru.billok.project"),lab.get("ru.billok.data"))!=("billok","uploads"):
        raise ValueError("Uploads volume lacks BillOK ownership labels")
    pg=json.loads(docker("inspect","billok_pg_prod",capture_output=True,text=True).stdout)[0]
    if pg.get("Name","").lstrip("/")!="billok_pg_prod" or pg.get("Config",{}).get("Image")!=PG_IMAGE:
        raise ValueError("Unexpected production PostgreSQL")
    if not pg.get("State",{}).get("Running",False):
        raise ValueError("Production PostgreSQL unavailable")
    if set(pg.get("NetworkSettings",{}).get("Networks") or {})!={"billok_pg_prod_net"}:
        raise ValueError("Production PostgreSQL network mismatch")
    if any(x for x in (pg.get("NetworkSettings",{}).get("Ports") or {}).values()):
        raise ValueError("Production PostgreSQL exposes a host port")
    mounts={m.get("Destination"):m for m in pg.get("Mounts",[])}
    m=mounts.get(PG_PATH)
    if not m or m.get("Type")!="volume" or m.get("Name")!="billok_pg_prod_data":
        raise ValueError("Production PostgreSQL volume mismatch")
    return ["billok_pg_prod_data","billok_uploads"]

def snapshot_location(parent):
    if not parent.is_absolute() or parent.is_symlink():
        raise ValueError("Backup parent must be an absolute, non-symlink path")
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    st = parent.stat()
    if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError("Backup parent must be owned by caller and have permissions 0700")
    return Path(tempfile.mkdtemp(prefix=".billok-pending-", dir=parent))


def valid_tar(snapshot):
    with tarfile.open(snapshot / "uploads.tar.gz", "r:gz") as tf:
        count = 0
        receipt_dir = False
        for member in tf:
            path = PurePosixPath(member.name)
            if (not member.isfile() and not member.isdir()) or path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsafe uploads archive entry")
            if not path.parts or path.parts[0] != "uploads":
                raise ValueError("Uploads archive escaped the expected root")
            if path.parts == ("uploads", "receipts"):
                receipt_dir = member.isdir()
            if member.isfile():
                source = tf.extractfile(member)
                if source is None:
                    raise ValueError("Unreadable archive member")
                while source.read(1024 * 1024):
                    pass
            count += 1
        if not receipt_dir or count < 2:
            raise ValueError("Uploads archive is missing the receipts directory")


def verify(snapshot):
    snapshot = Path(snapshot)
    if not snapshot.is_dir() or snapshot.is_symlink():
        raise ValueError("Snapshot must be a real directory")
    manifest_path = snapshot / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("Manifest missing or symlinked")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != "billok-8.9-v1":
        raise ValueError("Unknown backup format")
    digests = manifest.get("sha256")
    if not isinstance(digests, dict) or set(digests) != {"database.dump", "uploads.tar.gz"}:
        raise ValueError("Backup checksum manifest invalid")
    for name, expected in digests.items():
        file = snapshot / name
        if not file.is_file() or file.is_symlink() or file.stat().st_size == 0:
            raise ValueError("Backup part missing or empty: " + name)
        if digest(file) != expected:
            raise ValueError("Checksum mismatch: " + name)
    valid_tar(snapshot)
    print("BILLOK_BACKUP_VERIFY=PASS", flush=True)
    return manifest


def backup(container, parent):
    volumes = inspect_container(container)
    temp = snapshot_location(Path(parent))
    try:
        dump = temp / "database.dump"
        with dump.open("wb") as target:
            docker("exec","billok_pg_prod","pg_dump","-U","billok_prod","-d","billok_prod",
                   "-Fc","--no-owner","--no-acl",stdout=target,stderr=subprocess.PIPE)
        if not dump.stat().st_size:
            raise ValueError("Empty PostgreSQL dump")
        with dump.open("rb") as source:
            docker("exec","-i","billok_pg_prod","pg_restore","--list",
                   stdin=source,stdout=subprocess.DEVNULL)
        upload_dir = temp / "uploads"
        upload_dir.mkdir(mode=0o700)
        docker("cp", container + ":/app/uploads/.", str(upload_dir))
        if not (upload_dir / "receipts").is_dir():
            raise ValueError("Uploads did not contain a receipts directory")
        with tarfile.open(temp / "uploads.tar.gz", "w:gz") as archive:
            archive.add(upload_dir, arcname="uploads", recursive=True)
        shutil.rmtree(upload_dir)
        manifest = {
            "format": "billok-8.9-v1",
            "created_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_volumes": {"postgres": volumes[0], "uploads": volumes[1]},
            "sha256": {
                "database.dump": digest(temp / "database.dump"),
                "uploads.tar.gz": digest(temp / "uploads.tar.gz"),
            },
        }
        (temp / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        verify(temp)
        final = temp.parent / (
            "billok-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            + "-" + secrets.token_hex(4)
        )
        temp.rename(final)
        print("BILLOK_BACKUP_SAVED=" + str(final), flush=True)
    finally:
        if temp.exists():
            shutil.rmtree(temp)


def drill(snapshot):
    manifest = verify(snapshot)
    # Never start actual BillOK or attach existing volumes. The fresh container
    # has no host-network access and its data lives in two unique labeled volumes.
    snapshot = Path(snapshot).resolve()
    docker("image", "inspect", PG_IMAGE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    unique = str(int(time.time())) + "-" + str(secrets.randbelow(900000) + 100000)
    pg_volume = "billok-ci-temp-" + unique
    uploads_volume = "billok-ci-temp-" + str(int(time.time())) + "-" + str(secrets.randbelow(900000) + 100000)
    container = "billok-restore-drill-" + unique
    created_volumes = []
    container_started = False
    try:
        for name in (pg_volume, uploads_volume):
            exists = docker("volume", "inspect", name, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if exists.returncode == 0:
                raise ValueError("Refusing existing Docker volume: " + name)
            docker("volume", "create", "--label", "billok.ci.ephemeral=true",
                   "--label", "ru.billok.project=billok", name, stdout=subprocess.DEVNULL)
            created_volumes.append(name)
        pw = secrets.token_hex(20)
        docker("run", "-d", "--name", container, "--network", "none",
               "--memory", "384m", "--cpus", "0.7", "--pids-limit", "128",
               "--label", "ru.billok.project=billok",
               "--label", "ru.billok.component=restore-drill",
               "--mount", "type=volume,src=" + pg_volume + ",dst=" + PG_PATH,
               "-e", "POSTGRES_PASSWORD=" + pw, PG_IMAGE, stdout=subprocess.DEVNULL)
        container_started = True
        for _ in range(45):
            if docker("exec", container, "pg_isready", "-q", "-U", "postgres",
                      check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Isolated PostgreSQL restore container not ready")
        with (snapshot / "database.dump").open("rb") as source:
            docker("exec", "-i", container, "pg_restore", "-U", "postgres",
                   "-d", "postgres", "--exit-on-error", "--no-owner", "--no-acl",
                   stdin=source, stdout=subprocess.DEVNULL)
        rows = docker("exec", container, "psql", "-U", "postgres", "-d", "postgres",
                      "-tA", "-c", "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
                      capture_output=True, text=True).stdout.strip()
        if not rows.isdecimal() or int(rows) < 1:
            raise ValueError("Restore contains no public application tables")
        docker("run", "--rm", "--network", "none", "--memory", "128m", "--pids-limit", "64",
               "--mount", "type=volume,src=" + uploads_volume + ",dst=/restore",
               "--mount", "type=bind,src=" + str(snapshot) + ",dst=/input,readonly",
               PG_IMAGE, "sh", "-ec",
               "tar -xzf /input/uploads.tar.gz -C /restore --strip-components=1 && test -d /restore/receipts",
               stdout=subprocess.DEVNULL)
        print("BILLOK_RESTORE_DRILL=PASS (isolated PostgreSQL and uploads)", flush=True)
    finally:
        if container_started:
            docker("rm", "-f", container, check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for volume in reversed(created_volumes):
            docker("volume", "rm", volume, check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    bp = commands.add_parser("backup")
    bp.add_argument("--container", required=True)
    bp.add_argument("--directory", required=True, type=Path)
    vp = commands.add_parser("verify")
    vp.add_argument("--snapshot", type=Path, required=True)
    dp = commands.add_parser("drill")
    dp.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "backup":
        backup(args.container, args.directory)
    elif args.command == "verify":
        verify(args.snapshot)
    else:
        drill(args.snapshot)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError, OSError,
            json.JSONDecodeError, tarfile.TarError) as exc:
        print("BILLOK_BACKUP_ERROR=" + str(exc), file=sys.stderr)
        sys.exit(1)
