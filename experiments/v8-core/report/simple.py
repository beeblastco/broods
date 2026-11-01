"""Builds the short, plain version of the task-isolate results.
Every number is read from results/.

python3 report/simple.py results out.html
"""

import json
import statistics
import sys
from pathlib import Path

RESULTS = Path(sys.argv[1])
OUT = Path(sys.argv[2])


def rows(name):
    return [json.loads(line) for line in (RESULTS / name).read_text().splitlines() if line.strip()]


def per_minute(source, label, level=20):
    got = [r for r in source if r.get("kind") == "batch" and r["label"] == label and r["level"] == level]
    return statistics.fmean(r["level"] * 60000 / r["batchMs"] for r in got)


cold = {r["label"]: r for r in rows("cold-start-slim.jsonl")}
start_full = cold["fresh isolate per request"]["p50Ms"] / 1000
start_slim = cold["slim core, fresh isolate per request"]["p50Ms"] / 1000

main = rows("slim-d0.jsonl")
control = rows("slim-d0-control.jsonl")
tpm_today = per_minute(main, "bun+machine")
tpm_first = per_minute(main, "isolate+v8")
tpm_fixed = per_minute(main, "isolate+v8-slim")
tpm_same_sandbox = per_minute(control, "bun+v8")
scripted_passed = sum(r["ok"] for r in main + control if r.get("kind") == "batch")
scripted_total = sum(r["level"] for r in main + control if r.get("kind") == "batch")

real = [r for r in rows("real-slim.jsonl") if r.get("kind") == "batch"]
real_today = statistics.median(t for r in real if r["label"].startswith("bun+machine") for t in r["taskMs"]) / 1000
real_idea = statistics.median(t for r in real if r["label"].startswith("isolate") for t in r["taskMs"]) / 1000
real_passed = sum(r["ok"] for r in real)
real_total = sum(r["level"] for r in real)

analysis = json.loads((RESULTS / "real-haiku.analysis.json").read_text()) + json.loads(
    (RESULTS / "real-slim.analysis.json").read_text()
)
done = sum(r["ok"] for r in analysis)
model_share = sum(r["modelMsPerTask"] * r["ok"] for r in analysis) / sum(r["p50"] * r["ok"] for r in analysis)
usd_per_task = sum(r["usdPerTask"] * r["ok"] for r in analysis) / done

bundle = json.loads((RESULTS / "bundle-composition.json").read_text())
build = json.loads((RESULTS / "slim-build.json").read_text())
full_mb = build["fullEntryBytes"] / 1e6
slim_mb = build["slimEntryBytes"] / 1e6
own_mb = next(c["bytes"] for c in bundle["categories"] if c["name"].startswith("Broods")) / 1e6


def t(x, y, s, cls="t", anchor="middle"):
    return f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{s}</text>'


def arrow(x, y1, y2):
    return (
        f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2 - 7}" class="ln"/>'
        f'<polygon points="{x},{y2} {x - 5},{y2 - 8} {x + 5},{y2 - 8}" class="ln-head"/>'
    )


def bottom(y):
    return (
        f'<rect x="40" y="{y}" width="190" height="48" rx="8" class="svc"/>' + t(135, y + 30, "AI model")
        + f'<rect x="250" y="{y}" width="190" height="48" rx="8" class="svc"/>' + t(345, y + 30, "Sandbox")
    )


TODAY = (
    '<svg viewBox="0 0 480 300" role="img" class="pic" aria-label="Today: one always-on Broods server runs every task, with every feature loaded once.">'
    '<rect x="20" y="16" width="440" height="160" rx="12" class="big"/>'
    + t(240, 48, "One Broods server, always on", "t b")
    + "".join(
        f'<rect x="{40 + i * 140}" y="66" width="120" height="48" rx="8" class="task"/>' + t(100 + i * 140, 96, f"task {'ABC'[i]}")
        for i in range(3)
    )
    + t(240, 150, f"all of Broods loaded: {full_mb:.1f} MB", "t s")
    + arrow(135, 176, 230)
    + arrow(345, 176, 230)
    + bottom(232)
    + "</svg>"
)

IDEA = (
    '<svg viewBox="0 0 480 300" role="img" class="pic" aria-label="Your idea: each task gets its own small worker that starts when a user clicks and stops when done; workers share storage.">'
    '<rect x="150" y="8" width="180" height="34" rx="17" class="pill"/>'
    + t(240, 31, "a user clicks")
    + "".join(
        arrow(85 + i * 155, 42, 62)
        + f'<rect x="{15 + i * 155}" y="62" width="140" height="64" rx="8" class="worker"/>'
        + t(85 + i * 155, 89, f"worker {'ABC'[i]}", "t b")
        + t(85 + i * 155, 112, "starts, runs, stops", "t s")
        for i in range(3)
    )
    + '<rect x="15" y="136" width="450" height="40" rx="8" class="shared"/>'
    + t(240, 162, "shared storage and locks", "t s")
    + arrow(135, 176, 230)
    + arrow(345, 176, 230)
    + bottom(232)
    + "</svg>"
)


def bar_chart():
    items = [
        ("Today", tpm_today, ""),
        ("Your idea, first try", tpm_first, "bad"),
        ("Your idea, fixed", tpm_fixed, "hl"),
    ]
    top = max(v for _, v, _ in items)
    out = []
    for i, (name, value, cls) in enumerate(items):
        y = 4 + i * 70
        w = 380 * value / top
        out.append(t(0, y + 20, name, "t", "start"))
        out.append(f'<rect x="0" y="{y + 30}" width="{w:.1f}" height="28" rx="5" class="bar {cls}"/>')
        out.append(t(w + 10, y + 51, f"{value:.0f}", "t num", "start"))
    return (
        '<svg viewBox="0 0 480 214" role="img" class="chart" aria-label="'
        f"Tasks finished per minute with 20 users at once: today {tpm_today:.0f}, first try {tpm_first:.0f}, fixed {tpm_fixed:.0f}."
        '">' + "".join(out) + "</svg>"
    )


STYLE = """
:root {
  --bg: #f5f6f8; --panel: #ffffff; --ink: #18212b; --muted: #5b6876; --line: #cdd5de;
  --accent: #0b7a68; --accent-soft: #dcf1ec; --bad: #b42318; --bar: #9aabbd;
  --font: "Schibsted Grotesk", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f141a; --panel: #161d25; --ink: #e5eaef; --muted: #9ca8b4; --line: #2d3946;
    --accent: #47c8b0; --accent-soft: #143b35; --bad: #f2786c; --bar: #566576; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0f141a; --panel: #161d25; --ink: #e5eaef; --muted: #9ca8b4; --line: #2d3946;
  --accent: #47c8b0; --accent-soft: #143b35; --bad: #f2786c; --bar: #566576; color-scheme: dark;
}
body { background: var(--bg); color: var(--ink); font-family: var(--font); font-size: 17px; line-height: 1.6; }
main {
  max-width: 860px; margin: 0 auto; display: grid; gap: 44px;
  padding-block: 40px 64px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}
section { display: grid; gap: 14px; min-width: 0; }
h1 { font-size: clamp(30px, 6vw, 42px); line-height: 1.1; margin: 0; text-wrap: balance; }
h2 { font-size: 23px; margin: 0; text-wrap: balance; }
p, li { margin: 0; max-width: 62ch; }
.answer {
  background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--accent);
  border-radius: 10px; padding: 18px 20px; display: grid; gap: 8px;
}
.answer p:first-child { font-size: 21px; font-weight: 700; }
.pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 640px) { .pair { grid-template-columns: 1fr; } }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; display: grid; gap: 10px; min-width: 0; }
figcaption { font-weight: 700; }
svg { width: 100%; height: auto; display: block; }
svg .t { font-family: var(--font); font-size: 18px; fill: var(--ink); }
svg .t.b { font-weight: 700; }
svg .t.s { font-size: 15px; fill: var(--muted); }
svg .t.num { font-family: var(--mono); font-weight: 600; }
svg.chart .t { font-size: 18px; }
figure.bars { max-width: 620px; }
svg .big { fill: var(--bg); stroke: var(--line); stroke-width: 1.5; }
svg .task, svg .svc { fill: var(--panel); stroke: var(--line); stroke-width: 1.2; }
svg .pill { fill: var(--panel); stroke: var(--muted); }
svg .worker { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.5; }
svg .shared { fill: none; stroke: var(--accent); stroke-dasharray: 5 4; }
svg .ln { stroke: var(--muted); stroke-width: 1.4; }
svg .ln-head { fill: var(--muted); }
svg .bar { fill: var(--bar); }
svg .bar.hl { fill: var(--accent); }
svg .bar.bad { fill: var(--bad); opacity: 0.75; }
.nums { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.num { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.num b { display: block; font-family: var(--mono); font-size: 30px; line-height: 1.2; }
.num span { color: var(--muted); font-size: 15px; }
ol, ul { margin: 0; padding-left: 22px; display: grid; gap: 8px; }
.small { color: var(--muted); font-size: 14px; }
code { font-family: var(--mono); font-size: 0.85em; }
a { color: var(--accent); }
"""

page = f"""<title>Broods task isolates</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;700&family=JetBrains+Mono:wght@600&display=swap">
<style>{STYLE}</style>
<main>
<section>
<h1>Your idea: one small worker per task</h1>
<div class="answer">
<p>It works, but it is not faster than today yet.</p>
<p>My first test was wrong: every worker carried all of Broods ({full_mb:.1f} MB), even though a task only needs a small part of it. I fixed that, and the worker got about 3 times faster. Today's server is still faster on one machine.</p>
</div>
</section>

<section>
<h2>The two designs</h2>
<div class="pair">
<figure><figcaption>Today</figcaption>{TODAY}</figure>
<figure><figcaption>Your idea</figcaption>{IDEA}</figure>
</div>
</section>

<section>
<h2>What I measured</h2>
<p>Tasks finished per minute with 20 users at once (higher is better):</p>
<figure class="bars">{bar_chart()}</figure>
<div class="nums">
<div class="num"><b>{start_full:.1f} s</b><span>to start one worker, first try ({full_mb:.1f} MB)</span></div>
<div class="num"><b>{start_slim:.2f} s</b><span>to start one worker, fixed ({slim_mb:.1f} MB)</span></div>
</div>
</section>

<section>
<h2>Why it is still slower than today</h2>
<ol>
<li><strong>The sandbox.</strong> In the worker setup, the agent's commands run in a sandbox written in JavaScript, which is slow. Today's server on that same sandbox also drops to {tpm_same_sandbox:.0f} tasks a minute, so this is most of the gap.</li>
<li><strong>Starting up.</strong> Every worker starts from zero, while today's server is already running.</li>
</ol>
</section>

<section>
<h2>With the real AI model</h2>
<div class="nums">
<div class="num"><b>{real_today:.0f} s</b><span>per task today</span></div>
<div class="num"><b>{real_idea:.0f} s</b><span>per task with your idea</span></div>
</div>
<p>About {model_share * 100:.0f}% of every task is waiting for the AI to answer, and the AI is almost the whole bill (about ${usd_per_task:.3f} per task). No server design changes that part.</p>
</section>

<section>
<h2>What your idea gives</h2>
<ul>
<li>One customer's task can't slow down or crash another's.</li>
<li>Nothing runs, and nothing costs, when nobody is using Broods.</li>
<li>Tasks can spread over many cheap machines instead of one big server.</li>
</ul>
</section>

<section>
<h2>What it would take</h2>
<ol>
<li>Make Broods load only the parts a task uses. That is the fix I tested.</li>
<li>Move the things tasks share today (the task queue, the sandbox lock, usage counting) out of the server, so workers don't step on each other.</li>
<li>Stop a worker while its task waits, for example on a subagent, and start a new one when the answer comes back.</li>
</ol>
</section>

<section>
<p class="small">Tested on a local copy of Broods only, never on production. {scripted_passed} of {scripted_total} quick test tasks and {real_passed} of {real_total} real AI tasks passed. Broods' own code is {own_mb:.1f} MB of the {full_mb:.1f} MB; the rest is add-ons a task didn't use. Code and raw numbers: branch <code>claude/project-thread-met53d</code>, folder <code>experiments/v8-core</code>.</p>
</section>
</main>
"""

OUT.write_text(page)
print(OUT, len(page))
