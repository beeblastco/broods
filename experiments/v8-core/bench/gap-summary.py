"""Summarizes run-gap.sh rows: per level and arm, the task time (p50 and p95, averaged over rounds),
failures, the runtime's CPU per task, audit rows saved, and the database container's CPU per task
where the box could read it. Then each isolate arm against the Bun arm of the same level.
Usage: python3 gap-summary.py <out.jsonl> [...]"""

import json
import sys
from collections import defaultdict


def mean(values):
    return sum(values) / len(values) if values else float("nan")


for path in sys.argv[1:]:
    rows = [json.loads(line) for line in open(path) if line.strip()]
    arms = defaultdict(lambda: defaultdict(list))
    for row in rows:
        key = (row.get("level"), row.get("label"))
        if row.get("kind") == "batch":
            arm = arms[key]
            arm["p50"].append(row["exMcpP50"] / 1000)
            arm["p95"].append(row["exMcpP95"] / 1000)
            arm["ok"].append(row["ok"])
            arm["failed"].append(row["failed"])
            arm["cpu"].append(row["runtimeCpuMs"] / max(row["ok"], 1))
            arm["problems"].extend(row.get("problems", [])[:2])
        elif row.get("kind") == "audit":
            # The audit row follows its batch and carries no level; pin it to the last batch's arm.
            last = next(r for r in reversed(rows[: rows.index(row)]) if r.get("kind") == "batch")
            arms[(last["level"], row["label"])]["audit"].append(
                (row["runsCompleted"], round(row["tasksStarted"] * row["runsPerTask"]))
            )
        elif row.get("kind") == "box" and row.get("convexMs"):
            arms[key]["convex"].append(row["convexMs"] / max(row["tasks"], 1))
    print(f"== {path}")
    print(f"  {'level':>5}  {'arm':<34} {'rounds':>6} {'p50 s':>6} {'p95 s':>6} {'failed':>6} {'cpu ms':>7} {'audit':>9} {'db ms':>6}")
    for (level, label), arm in sorted(arms.items(), key=lambda item: (item[0][0] or 0, item[0][1])):
        if not arm["p50"]:
            continue
        saved = sum(done for done, _ in arm["audit"])
        expected = sum(want for _, want in arm["audit"])
        convex = f"{mean(arm['convex']):.0f}" if arm["convex"] else "-"
        print(
            f"  {level:>5}  {label:<34} {len(arm['p50']):>6} {mean(arm['p50']):>6.2f} {mean(arm['p95']):>6.2f}"
            f" {sum(arm['failed']):>6} {mean(arm['cpu']):>7.0f} {f'{saved}/{expected}':>9} {convex:>6}"
        )
        for problem in arm["problems"][:2]:
            print(f"         problem: {str(problem)[:160]}")
    # Each isolate arm against the Bun arm on the same sandbox: cf with cf, the local V8 or native
    # sandbox with native.
    for (level, label), arm in sorted(arms.items(), key=lambda item: (item[0][0] or 0, item[0][1])):
        if not label.startswith("isolate+") or not arm["p50"]:
            continue
        want = "bun+cf" if label.startswith("isolate+cf") else "bun+native"
        base = arms.get((level, want))
        if base and base["p50"]:
            ratio = mean(arm["p50"]) / mean(base["p50"])
            print(f"  L{level}: {label} takes {ratio:.0%} of {want}'s time per task (p50)")
