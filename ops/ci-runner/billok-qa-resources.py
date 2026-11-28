#!/usr/bin/python3
"""TASK-BILLOK-009: isolated mobile QA PostgreSQL lifecycle and orphan guard."""
import argparse
import datetime as dt
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.request
from dataclasses import dataclass

REPO = "kurt525/billok"
WORKFLOW_ID = 393891880
WORKFLOW_PATH = ".github/workflows/billok-ci.yml"
IMAGE = "postgres:16-alpine"
DATA = "/var/lib/postgresql/data"
PREFIX = "billok-mobile-qa-"
VOLUME_PREFIX = PREFIX + "data-"
ID = r"[1-9][0-9]{0,18}"
NAME = re.compile(r"^billok-mobile-qa-(?:data-)?(" + ID + r")-(" + ID + r")$")
NONCE = re.compile(r"[a-f0-9]{32}")
MIN_AGE = dt.timedelta(hours=24)
BASE_LABELS = {
    "ru.billok.project": "billok",
    "billok.ci.ephemeral": "true",
    "ru.billok.component": "mobile-qa-postgres",
}
DOCKER = "/usr/bin/docker"
WORKER = "/opt/actions-runner[^ ]*/bin/Runner.Worker"


class Refused(RuntimeError):
    """Fixed diagnostic only; never include command output or environment."""


def require(condition, reason):
    if not condition:
        raise Refused(reason)


@dataclass(frozen=True)
class Identity:
    run: str
    attempt: str
    owner: str

    def __post_init__(self):
        require(bool(re.fullmatch(ID, self.run) and re.fullmatch(ID, self.attempt)
                     and NONCE.fullmatch(self.owner)), "invalid QA identity")

    @property
    def container(self):
        return PREFIX + self.run + "-" + self.attempt

    @property
    def volume(self):
        return VOLUME_PREFIX + self.run + "-" + self.attempt

    @property
    def labels(self):
        return dict(BASE_LABELS, **{
            "billok.ci.run": self.run,
            "billok.ci.attempt": self.attempt,
            "billok.ci.owner": self.owner,
        })

    def label_args(self):
        return [arg for k, v in self.labels.items() for arg in ("--label", k + "=" + v)]


def docker(*args, timeout=30):
    # Never use a caller-selected daemon, context or Docker configuration.
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": os.path.expanduser("~"),
           "LANG": "C.UTF-8"}
    try:
        cp = subprocess.run([DOCKER, "--host", "unix:///var/run/docker.sock", *args],
                            env=env, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        raise Refused("Docker command unavailable") from exc
    require(cp.returncode == 0, "Docker command failed: " + args[0])
    return cp.stdout.strip()


def listed(kind):
    if kind == "volume":
        return set(docker("volume", "ls", "--format", "{{.Name}}").splitlines())
    return set(docker("ps", "-a", "--format", "{{.Names}}").splitlines())


def inspect(kind, name):
    if name not in listed(kind):
        return None
    data = json.loads(docker(kind, "inspect", name))
    require(isinstance(data, list) and len(data) == 1, "invalid Docker inspect response")
    return data[0]


def valid_volume(info, ident):
    require(info.get("Name") == ident.volume and info.get("Driver") == "local"
            and not info.get("Options") and info.get("Scope") == "local"
            and all((info.get("Labels") or {}).get(k) == v for k, v in ident.labels.items()),
            "volume identity mismatch")


def valid_container(info, ident):
    cfg = info["Config"]
    host = info["HostConfig"]
    env = dict(s.split("=", 1) for s in cfg.get("Env", []) if "=" in s)
    mounts = info.get("Mounts", [])
    ports = host.get("PortBindings") or {}
    require(info.get("Name") == "/" + ident.container
            and re.fullmatch(r"[a-f0-9]{64}", info.get("Id", ""))
            and cfg.get("Image") == IMAGE
            and all((cfg.get("Labels") or {}).get(k) == v for k, v in ident.labels.items())
            and env.get("POSTGRES_USER") == "billokqa"
            and env.get("POSTGRES_DB") == "billokqa"
            and env.get("POSTGRES_PASSWORD") == "billokqa_local_only"
            and len(mounts) == 1 and mounts[0].get("Type") == "volume"
            and mounts[0].get("Name") == ident.volume
            and mounts[0].get("Destination") == DATA and mounts[0].get("RW") is True
            and host.get("NetworkMode") == "bridge"
            and set(info.get("NetworkSettings", {}).get("Networks", {})) == {"bridge"}
            and set(ports) == {"5432/tcp"} and len(ports["5432/tcp"]) == 1
            and ports["5432/tcp"][0].get("HostIp") == "127.0.0.1"
            and not host.get("Privileged"),
            "container identity mismatch")


def attached(name):
    return set(docker("ps", "-aq", "--no-trunc", "--filter", "volume=" + name).splitlines())


def start(ident, record):
    require(inspect("container", ident.container) is None
            and inspect("volume", ident.volume) is None, "QA resource name collision")
    # Persist the invocation-specific identity before any creation; a collision
    # never authorizes cleanup of a pre-existing object's different nonce.
    record({"BILLOK_QA_RESOURCE_OWNER": ident.owner})
    docker("volume", "create", "--driver", "local", *ident.label_args(), ident.volume)
    volume = inspect("volume", ident.volume)
    require(volume is not None, "created volume missing")
    valid_volume(volume, ident)
    require(not attached(ident.volume), "QA volume already attached")
    docker("run", "-d", "--rm", "--network", "bridge", "--name", ident.container,
           *ident.label_args(), "--mount", "type=volume,source=" + ident.volume + ",target=" + DATA,
           "-e", "POSTGRES_USER=billokqa", "-e", "POSTGRES_PASSWORD=billokqa_local_only",
           "-e", "POSTGRES_DB=billokqa", "-p", "127.0.0.1::5432", IMAGE, timeout=120)
    info = inspect("container", ident.container)
    require(info is not None, "created container missing")
    valid_container(info, ident)
    binding = docker("port", info["Id"], "5432/tcp")
    match = re.fullmatch(r"127\.0\.0\.1:([1-9][0-9]{0,4})", binding)
    require(match and int(match[1]) <= 65535, "invalid QA loopback port")
    record({"BILLOK_QA_DB_CONTAINER": ident.container,
            "DATABASE_URL": "postgresql://billokqa:billokqa_local_only@127.0.0.1:"
                            + match[1] + "/billokqa"})
    print("BILLOK_QA_START=PASS")


def idle():
    result = subprocess.run(["/usr/bin/pgrep", "-f", WORKER],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    return result.returncode == 1


def no_clients(info):
    state = info["State"]
    if state.get("Status") in ("created", "exited"):
        return not state.get("Running")
    if state.get("Status") != "running" or state.get("Paused") or state.get("Restarting"):
        return False
    return docker("exec", info["Id"], "psql", "-U", "billokqa", "-d", "billokqa",
                  "-Atqc", "SELECT count(*) FROM pg_stat_activity WHERE "
                  "backend_type='client backend' AND pid<>pg_backend_pid()", timeout=10) == "0"


def old_enough(info):
    created = dt.datetime.fromisoformat(info["CreatedAt" if "CreatedAt" in info else "Created"]
                                       .replace("Z", "+00:00"))
    return dt.datetime.now(dt.timezone.utc) - created >= MIN_AGE


def cleanup(ident, orphan=False, dry=False, on_remove=None):
    """Return counts. No force for volumes. Re-inspect immediately before removal."""
    info = inspect("container", ident.container)
    volume = inspect("volume", ident.volume)
    if volume is not None:
        valid_volume(volume, ident)
    if info is not None:
        valid_container(info, ident)
        require(volume is not None, "QA container volume missing")
        require(attached(ident.volume) == {info["Id"]}, "QA volume shared or attachment unknown")
    if orphan:
        require(idle(), "active CI worker")
        require(all(old_enough(x) for x in (info, volume) if x is not None), "fresh QA resource")
        if info is not None:
            require(no_clients(info), "QA container busy or state unconfirmed")
    found = int(info is not None) + int(volume is not None)
    if dry:
        if info is None and volume is not None:
            require(not attached(ident.volume), "QA volume attached")
        return found, 0
    removed = 0
    if info is not None:
        current = inspect("container", ident.container)
        require(current is not None and current["Id"] == info["Id"], "QA container changed")
        valid_container(current, ident)
        require(attached(ident.volume) == {info["Id"]}, "QA volume attachment changed")
        if orphan:
            require(idle() and no_clients(current) and idle(), "QA resource became active")
        # -v removes any anonymous volume; named volume is handled separately.
        try:
            docker("rm", "-f", "-v", info["Id"], timeout=45)
        except Refused:
            require(inspect("container", ident.container) is None, "QA container removal failed")
        require(inspect("container", ident.container) is None, "QA container still present")
        removed += 1
        if on_remove is not None:
            on_remove("container")
    if volume is not None:
        current = inspect("volume", ident.volume)
        require(current is not None and current.get("CreatedAt") == volume.get("CreatedAt"),
                "QA volume changed")
        valid_volume(current, ident)
        require(not attached(ident.volume), "QA volume attached")
        if orphan:
            require(idle(), "active CI worker")
        docker("volume", "rm", ident.volume)
        require(inspect("volume", ident.volume) is None, "QA volume still present")
        removed += 1
        if on_remove is not None:
            on_remove("volume")
    return found, removed


def get_run(path):
    # Fixed public GitHub API, TLS validation; no runner or production token.
    request = urllib.request.Request("https://api.github.com/repos/" + REPO + "/actions/runs/" + path,
                                     headers={"User-Agent": "BillOK-ci-qa-guard",
                                              "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = response.read(1024 * 1024 + 1)
    require(len(payload) <= 1024 * 1024, "GitHub response too large")
    return json.loads(payload)


def completed(ident):
    def trusted(run):
        return (run.get("id") == int(ident.run) and run.get("workflow_id") == WORKFLOW_ID
                and run.get("path") == WORKFLOW_PATH
                and (run.get("repository") or {}).get("full_name") == REPO
                and (run.get("head_repository") or {}).get("full_name") == REPO
                and run.get("event") in ("push", "workflow_dispatch")
                and run.get("status") == "completed" and bool(run.get("conclusion")))
    try:
        latest = get_run(ident.run)
        if not trusted(latest) or latest.get("run_attempt", 0) < int(ident.attempt):
            return False
        if latest["run_attempt"] == int(ident.attempt):
            return True
        old = get_run(ident.run + "/attempts/" + ident.attempt)
        return trusted(old) and old.get("run_attempt") == int(ident.attempt)
    except (OSError, ValueError, Refused, TypeError):
        return False


def orphans(dry):
    require(os.geteuid() == 0, "root required for orphan maintenance")
    require(idle(), "active CI worker")
    candidates = {}
    skipped_groups = 0
    discovered = 0
    for kind in ("container", "volume"):
        for name in sorted(listed(kind)):
            if not NAME.fullmatch(name):
                continue
            discovered += 1
            info = inspect(kind, name)
            if info is None:
                continue
            labels = (info.get("Labels") if kind == "volume" else info["Config"].get("Labels")) or {}
            match = NAME.fullmatch(name)
            try:
                ident = Identity(match[1], match[2], labels.get("billok.ci.owner", ""))
                (valid_volume if kind == "volume" else valid_container)(info, ident)
                require(old_enough(info), "fresh QA resource")
                candidates.setdefault((ident.run, ident.attempt), set()).add(ident)
            except (Refused, KeyError, ValueError, TypeError):
                print("BILLOK_QA_ORPHAN_SKIP=" + name + " identity/age unconfirmed")
    found = sum(len(v) for v in candidates.values())
    removed = 0
    planned = 0
    errors = 0
    # Bound unauthenticated API requests; rotate the starting point so an
    # unavailable old run cannot permanently starve later candidates.
    entries = sorted(candidates.items())
    if entries:
        offset = int(dt.datetime.now(dt.timezone.utc).timestamp() // 3600) % len(entries)
        entries = entries[offset:] + entries[:offset]

    def count_removal(kind):
        nonlocal removed
        removed += 1

    for index, (key, identities) in enumerate(entries):
        label = "-".join(key)
        if index >= 15 or len(identities) != 1 or not idle():
            skipped_groups += 1
            print("BILLOK_QA_ORPHAN_SKIP=" + label + " budget/conflict/active worker")
            continue
        ident = next(iter(identities))
        if not completed(ident):
            skipped_groups += 1
            print("BILLOK_QA_ORPHAN_SKIP=" + label + " run completion unconfirmed")
            continue
        try:
            n, deleted = cleanup(ident, orphan=True, dry=dry, on_remove=count_removal)
            planned += n
            print("BILLOK_QA_ORPHAN_" + ("DRY_RUN=" if dry else "REMOVED=") + label + " count=" + str(n if dry else deleted))
        except (Refused, KeyError, ValueError, TypeError, OSError, subprocess.SubprocessError) as exc:
            skipped_groups += 1
            errors += 1
            reason = str(exc) if isinstance(exc, Refused) else "verification unavailable"
            print("BILLOK_QA_ORPHAN_SKIP=" + label + " " + reason)
    print(f"BILLOK_QA_ORPHAN_SUMMARY found_resources={discovered} found_groups={found} removed_resources={removed} "
          f"eligible_resources={planned} skipped_groups={skipped_groups} "
          f"unremoved_resources={max(0, discovered - removed)} errors={errors}")
    return 1 if errors else 0


def record_env(values):
    with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as file:
        for key, value in values.items():
            file.write(key + "=" + value + "\n")
        file.flush()
        os.fsync(file.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "cleanup", "orphans"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.action == "orphans":
        return orphans(args.dry_run)
    require(not args.dry_run, "dry run is for orphan maintenance only")
    require(os.environ.get("GITHUB_REPOSITORY") == REPO, "unexpected CI repository")
    run, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if args.action == "start":
        start(Identity(run, attempt, secrets.token_hex(16)), record_env)
    else:
        owner = os.environ.get("BILLOK_QA_RESOURCE_OWNER", "")
        if not owner:
            print("BILLOK_QA_CLEANUP=SKIP no invocation identity")
            return 0
        found, removed = cleanup(Identity(run, attempt, owner))
        print(f"BILLOK_QA_CLEANUP=PASS found={found} removed={removed}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Refused, KeyError, ValueError, TypeError, OSError, subprocess.SubprocessError) as exc:
        # Never print raw Docker/API response, credentials or arbitrary errors.
        print("BILLOK_QA_RESOURCE=FAIL " + (str(exc) if isinstance(exc, Refused) else "verification unavailable"),
              file=sys.stderr)
        sys.exit(1)
