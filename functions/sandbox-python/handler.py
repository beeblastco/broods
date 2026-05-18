"""
Python sandbox Lambda for workspace file execution.
Keep Python runtime process execution here.
"""

import os
import subprocess
import sys
import time


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
        if not os.path.isfile(file_path):
            raise FileNotFoundError(file_path)
        result = run_python_file(
            file_path,
            workspace_root,
            event.get("args") or [],
            int(event.get("timeoutSeconds", 30)),
            int(event.get("outputLimitBytes", 64 * 1024)),
        )
        result.update({
            "runtime": "python",
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
