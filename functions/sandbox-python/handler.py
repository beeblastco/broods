"""
Python sandbox Lambda for workspace file execution.
Keep Python runtime process execution here.
"""

import os
import shutil
import subprocess
import tempfile
import time


def handler(event, context):
    started_at = time.time()
    workdir = tempfile.mkdtemp(prefix="sandbox-python-")
    try:
        if event.get("runtime") != "python":
            raise ValueError("sandbox-python only supports python requests")

        entry = event.get("entry") or {}
        entry_path = entry.get("path", "")
        if not entry_path.endswith(".py"):
            raise ValueError("python sandbox only executes .py files")

        file_path = os.path.join(workdir, os.path.basename(entry_path))
        with open(file_path, "w", encoding="utf-8") as handle:
            handle.write(entry.get("content", ""))

        result = run_python_file(
            file_path,
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
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def run_python_file(file_path, args, timeout_seconds, output_limit_bytes):
    try:
        completed = subprocess.run(
            ["python3", "-I", "-S", file_path, *args],
            cwd=os.path.dirname(file_path),
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


def truncate_output(value, limit):
    if len(value) <= limit:
        return value.decode("utf-8", errors="replace"), False

    return value[:limit].decode("utf-8", errors="replace") + "\n[output truncated]", True


def append_timeout(stderr, timeout_seconds):
    timeout_text = f"Timed out after {timeout_seconds}s"
    return "\n".join(part for part in [stderr, timeout_text] if part)
