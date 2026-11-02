"""Builds the benchmark report page from the result files, so every number on
the page comes straight from the measured rows. Narrative lives in text.py."""

import html
import json
import statistics
import sys
from pathlib import Path

RES = Path(sys.argv[1])
OUT = Path(sys.argv[2])
sys.path.insert(0, str(Path(__file__).parent))
import text  # noqa: E402

ARMS = {
    "bun+machine": ("Today: Bun core + Linux shell", "a1"),
    "workerd+v8": ("V8: core on workerd + V8 sandbox", "a2"),
    "bun+v8": ("Control: Bun core + V8 sandbox", "a3"),
    "isolate+v8": ("Fresh V8 isolate per task + V8 sandbox", "a4"),
}


def rows(name):
    path = RES / name
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else float("nan")


def fold(batch_rows):
    """One row per arm and level, same rules as bench/summarize.ts."""
    groups = {}
    for r in batch_rows:
        if r.get("kind") != "batch":
            continue
        arm = r["label"].split("/")[0]
        groups.setdefault((arm, r["level"]), []).append(r)
    out = {}
    for (arm, level), g in groups.items():
        tasks = sum(r["level"] for r in g)
        sandbox_rows = [r for r in g if isinstance(r.get("sandboxCpuMs"), (int, float))]
        out[(arm, level)] = {
            "rounds": len(g),
            "tasks": tasks,
            "ok": sum(r["ok"] for r in g),
            "p50": median([r["p50"] for r in g]),
            "p95": median([r["p95"] for r in g]),
            "exMcp": median([r["exMcpP50"] for r in g]),
            "mcp": median([r["mcpP50"] for r in g]),
            "perMin": 60000 * tasks / sum(r["batchMs"] for r in g),
            "coreCpu": sum(r["runtimeCpuMs"] for r in g) / tasks,
            "sandboxCpu": (sum(r["sandboxCpuMs"] for r in sandbox_rows) / sum(r["level"] for r in sandbox_rows)) if sandbox_rows else float("nan"),
            "rssPeak": max(r["runtimeRssPeakMb"] for r in g),
            "rssStart": min(r["runtimeRssStartMb"] for r in g),
            # Memory each task in flight held: the batch's peak over its start, per task, worst round.
            "memPerTask": max((r["runtimeRssPeakMb"] - r["runtimeRssStartMb"]) / r["level"] for r in g),
            "sbMemPerTask": max([v for v in ((r.get("sandboxRssPeakMb", float("nan")) - r.get("sandboxRssStartMb", float("nan"))) / r["level"] for r in g) if v == v] or [float("nan")]),
            "convex": sum(r["convexCallsPerTask"] * r["level"] for r in g) / tasks,
            "model": sum(r["modelCallsPerTask"] * r["level"] for r in g) / tasks,
            "other": sum(r["otherRuntimeModelCalls"] for r in g),
        }
    return out


def audits(all_rows):
    out = {}
    for r in all_rows:
        if r.get("kind") == "audit":
            arm = r["label"].split("/")[0]
            a = out.setdefault(arm, [0, 0])
            a[0] += r["runsCompleted"]
            a[1] += r["tasksStarted"]
    return out


def esc(value):
    return html.escape(str(value))


def num(value, digits=0):
    if value is None or value != value:
        return "–"
    return f"{value:,.{digits}f}"


def secs(ms, digits=1):
    if ms is None or ms != ms:
        return "–"
    return f"{ms / 1000:,.{digits}f}"


def arm_cell(arm):
    name, cls = ARMS[arm]
    return f'<th scope="row"><span class="key {cls}"></span>{esc(name)}</th>'


def table(head, body, caption=None, cls=""):
    cap = f"<caption>{caption}</caption>" if caption else ""
    th = "".join(f'<th scope="col">{h}</th>' for h in head)
    return f'<div class="table-wrap"><table class="{cls}">{cap}<thead><tr>{th}</tr></thead><tbody>{"".join(body)}</tbody></table></div>'


def line_chart(series, levels, title, y_label, chart_id, unit="s", digits=1):
    """Small line chart: x = tasks at once (ordinal), one line per arm."""
    w, h = 440, 250
    left, right, top, bottom = 46, 16, 16, 40
    ys = [v for s in series for v in s["values"] if v == v]
    y_max = max(ys) if ys else 1
    step = next(s for s in (1, 2, 5, 10, 20, 25, 50, 100, 200, 500) if y_max / s <= 6)
    top_tick = step * (int(y_max / step) + 1)
    def x(i):
        return left + i * (w - left - right) / (len(levels) - 1)
    def y(v):
        return top + (h - top - bottom) * (1 - v / top_tick)
    grid = []
    for t in range(0, top_tick + 1, step):
        grid.append(f'<line class="grid" x1="{left}" x2="{w - right}" y1="{y(t):.1f}" y2="{y(t):.1f}"/>')
        grid.append(f'<text class="tick" x="{left - 8}" y="{y(t) + 4:.1f}" text-anchor="end">{t}</text>')
    xt = "".join(f'<text class="tick" x="{x(i):.1f}" y="{h - bottom + 18}" text-anchor="middle">{lv}</text>' for i, lv in enumerate(levels))
    lines = []
    for s in series:
        pts = [(x(i), y(v), v, levels[i]) for i, v in enumerate(s["values"]) if v == v]
        d = " ".join(f"{'M' if k == 0 else 'L'}{px:.1f},{py:.1f}" for k, (px, py, _, _) in enumerate(pts))
        lines.append(f'<path class="line {s["cls"]}" d="{d}"/>')
        for px, py, v, lv in pts:
            lines.append(f'<circle class="dot {s["cls"]}" cx="{px:.1f}" cy="{py:.1f}" r="4.5"><title>{esc(s["name"])}: {v:,.{digits}f} {unit} at {lv} at once</title></circle>')
    return f'''<figure class="chart" id="{chart_id}">
<figcaption>{title}</figcaption>
<svg viewBox="0 0 {w} {h}" role="img" aria-label="{esc(title)}">
{''.join(grid)}
<line class="axis" x1="{left}" x2="{w - right}" y1="{y(0):.1f}" y2="{y(0):.1f}"/>
{xt}
<text class="axis-label" x="{(left + w - right) / 2}" y="{h - 4}" text-anchor="middle">tasks started at once</text>
<text class="axis-label" x="12" y="{top + (h - top - bottom) / 2}" text-anchor="middle" transform="rotate(-90 12 {top + (h - top - bottom) / 2})">{y_label}</text>
{''.join(lines)}
</svg>
</figure>'''


def legend(arms):
    return '<div class="legend">' + "".join(f'<span><span class="key {ARMS[a][1]}"></span>{esc(ARMS[a][0])}</span>' for a in arms) + "</div>"


def main():
    sets = {
        "d0": rows("scripted-d0.jsonl"),
        "d2": rows("scripted-d2000.jsonl"),
        "agents": rows("scripted-d0-agents.jsonl") + rows("isolate-d0.jsonl"),
        "iso1": rows("isolate-d0-one-agent.jsonl"),
        "real": rows("real-haiku.jsonl"),
        "real_sep": rows("real-haiku-separate-files.jsonl"),
        "drain": rows("check-drain.jsonl"),
    }
    real_an = json.loads((RES / "real-haiku.analysis.json").read_text()) if (RES / "real-haiku.analysis.json").exists() else []
    data = {name: fold(r) for name, r in sets.items()}
    data.update({
        "audit": {name: audits(r) for name, r in sets.items()},
        "real_an": real_an,
        "real_sep_an": json.loads((RES / "real-haiku-separate-files.analysis.json").read_text()) if (RES / "real-haiku-separate-files.analysis.json").exists() else [],
        "probe": rows("sandbox-probe.jsonl"),
        "cold": rows("cold-start.jsonl"),
        "hang": rows("queue-hang-workerd-8workers.jsonl"),
        "lost": rows("scripted-d2000-workerd-prefix.jsonl"),
    })
    page = text.page(data, dict(table=table, arm_cell=arm_cell, line_chart=line_chart, legend=legend, num=num, secs=secs, esc=esc, median=median, ARMS=ARMS))
    OUT.write_text(page)
    print("wrote", OUT, len(page), "bytes")


main()
