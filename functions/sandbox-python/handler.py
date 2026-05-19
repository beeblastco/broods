"""
Python sandbox Lambda for workspace file execution.
Keep Python runtime process execution here.
"""

import os
import subprocess
import sys
import time

MAX_ARTIFACT_BYTES = 256 * 1024
ENTRY_FILE_WAIT_MS = 5000
ENTRY_FILE_WAIT_INTERVAL_MS = 100

def handler(event, context):
    started_at = time.time()
    try:
        if event.get("runtime") != "python":
            raise ValueError("sandbox-python only supports python requests")

        entry_path = event.get("entryPath", "")
        if not entry_path.endswith(".py"):
            raise ValueError("python sandbox only executes .py files")

        workspace_root = resolve_workspace_root(event.get("workspaceRoot"), event.get("namespace", ""))
        file_path = resolve_workspace_path(workspace_root, entry_path)
        await_file(file_path)
        if not os.path.isfile(file_path):
            raise FileNotFoundError(file_path)
        before = snapshot_workspace(workspace_root)
        result = run_python_file(
            file_path,
            workspace_root,
            event.get("args") or [],
            int(event.get("timeoutSeconds", 30)),
            int(event.get("outputLimitBytes", 64 * 1024)),
        )
        result.update({
            "runtime": "python",
            "artifacts": collect_changed_artifacts(workspace_root, before),
            "durationMs": int((time.time() - started_at) * 1000),
        })
        return result
    except Exception as err:
        return {
            "ok": False,
            "runtime": "python",
            "exitCode": None,
            "stdout": "",
            "stderr": str(err),
            "durationMs": int((time.time() - started_at) * 1000),
        }

def await_file(file_path: str) -> None:
    deadline = time.time() * 1000 + ENTRY_FILE_WAIT_MS
    last_error = None

    while time.time() * 1000 < deadline:
        try:
            if os.path.isfile(file_path):
                return
        except Exception as err:
            last_error = err
            time.sleep(ENTRY_FILE_WAIT_INTERVAL_MS / 1000)
            continue

    if last_error:
        raise last_error
    if not os.path.isfile(file_path):
        raise FileNotFoundError(file_path)


def run_python_file(file_path, cwd, args, timeout_seconds, output_limit_bytes):
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-S", file_path, *args],
            cwd=cwd,
            env={
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": "/tmp",
                "TMPDIR": "/tmp",
                "PYTHONPATH": "",
            },
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        stdout, stdout_truncated = truncate_output(completed.stdout, output_limit_bytes)
        stderr, stderr_truncated = truncate_output(completed.stderr, output_limit_bytes)
        return {
            "ok": completed.returncode == 0,
            "exitCode": completed.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": stdout_truncated or stderr_truncated,
        }
    except subprocess.TimeoutExpired as err:
        stdout, stdout_truncated = truncate_output(err.stdout or b"", output_limit_bytes)
        stderr, stderr_truncated = truncate_output(err.stderr or b"", output_limit_bytes)
        return {
            "ok": False,
            "exitCode": None,
            "stdout": stdout,
            "stderr": append_timeout(stderr, timeout_seconds),
            "timedOut": True,
            "truncated": stdout_truncated or stderr_truncated,
        }


def resolve_workspace_root(root, namespace):
    assert_safe_namespace(namespace)
    return os.path.abspath(os.path.join(root or "/mnt/workspaces", namespace))


def resolve_workspace_path(workspace_root, entry_path):
    normalized_entry = entry_path[1:] if entry_path.startswith("/") else entry_path
    resolved = os.path.abspath(os.path.join(workspace_root, normalized_entry))
    common = os.path.commonpath([workspace_root, resolved])
    if common != workspace_root or resolved == workspace_root:
        raise ValueError("Invalid entry path: resolved outside workspace root")
    return resolved


def snapshot_workspace(root):
    files = {}
    for path in iter_workspace_files(root):
        stats = os.stat(path)
        files[os.path.relpath(path, root)] = {
            "mtime_ns": stats.st_mtime_ns,
            "size": stats.st_size,
        }
    return files


def collect_changed_artifacts(root, before):
    import base64

    artifacts = []
    for path in iter_workspace_files(root):
        relative_path = os.path.relpath(path, root)
        stats = os.stat(path)
        previous = before.get(relative_path)
        if previous and previous["mtime_ns"] == stats.st_mtime_ns and previous["size"] == stats.st_size:
            continue
        if stats.st_size > MAX_ARTIFACT_BYTES:
            continue

        with open(path, "rb") as file:
            content = file.read()

        artifacts.append({
            "kind": "file",
            "path": f"/{relative_path}",
            "mediaType": "application/octet-stream",
            "dataBase64": base64.b64encode(content).decode("ascii"),
            "metadata": {
                "size": stats.st_size,
            },
        })
    return artifacts


def iter_workspace_files(root):
    for current_root, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in (".", "..")]
        for file_name in files:
            path = os.path.join(current_root, file_name)
            if os.path.isfile(path):
                yield path


def assert_safe_namespace(namespace):
    import re

    if not re.fullmatch(r"fs-[a-f0-9]{40}", namespace):
        raise ValueError("Invalid workspace namespace")


def truncate_output(value, limit):
    if len(value) <= limit:
        return value.decode("utf-8", errors="replace"), False

    return value[:limit].decode("utf-8", errors="replace") + "\n[output truncated]", True


def append_timeout(stderr, timeout_seconds):
    timeout_text = f"Timed out after {timeout_seconds}s"
    return "\n".join(part for part in [stderr, timeout_text] if part)
