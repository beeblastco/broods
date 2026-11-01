"""Builds the short, plain page on the worker-per-task idea: where it stands
after the speed-up work. Every number is read from results/; only prices and
the bundle size come from files written by the build.

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


def batches(source, label, level):
    # A batch where every task failed on the public docs server measures nothing.
    return [
        r
        for r in source
        if r.get("kind") == "batch" and r["label"] == label and r["level"] == level and r["ok"] > 0
    ]


def per_minute(source, label, level=20):
    return statistics.fmean(level * 60000 / r["batchMs"] for r in batches(source, label, level))


def cpu_per_task(source, label, key="runtimeCpuMs", level=20):
    return statistics.fmean(r[key] / level for r in batches(source, label, level))


def rows_kept(source, label):
    audits = [r for r in source if r.get("kind") == "audit" and r["label"] == label]
    return sum(r["runsCompleted"] for r in audits) / sum(3 * r["tasksStarted"] for r in audits)


old = rows("slim-d0.jsonl")
levers = rows("fast-d0.jsonl")
final = rows("fast-final.jsonl")

tpm_today = per_minute(final, "bun+machine")
tpm_today_10 = per_minute(final, "bun+machine", 10)
tpm_first = per_minute(old, "isolate+v8")
tpm_last = per_minute(old, "isolate+v8-slim")
tpm_now = per_minute(final, "isolate+v8-fast")
tpm_now_10 = per_minute(final, "isolate+v8-fast", 10)
tpm_engine = per_minute(final, "workerd+native")
tpm_today_shell = per_minute(final, "bun+native")
tpm_warm_only = per_minute(levers, "isolate+v8-warm")
tpm_shell_only = per_minute(levers, "isolate+v8-slim-native")

cpu_last = cpu_per_task(old, "isolate+v8-slim")
cpu_now = cpu_per_task(final, "isolate+v8-fast")
cpu_today = cpu_per_task(final, "bun+machine")
cpu_engine = cpu_per_task(final, "workerd+native")
convex_today = statistics.fmean(r["convexCallsPerTask"] for r in batches(final, "bun+machine", 20))
convex_shell = statistics.fmean(r["convexCallsPerTask"] for r in batches(final, "bun+native", 20))
sbx_js = cpu_per_task(levers, "isolate+v8-warm", "sandboxCpuMs")
sbx_shell = cpu_per_task(levers, "isolate+v8-warm-native", "sandboxCpuMs")

lost_before = 1 - rows_kept([r for r in levers if r.get("tasksStarted") == 41], "isolate+v8-warm-native")
kept_now = rows_kept(final, "isolate+v8-fast")

cold = {r["label"]: r for r in rows("cold-start-slim.jsonl")}
start_full = cold["fresh isolate per request"]["p50Ms"] / 1000
start_slim = cold["slim core, fresh isolate per request"]["p50Ms"] / 1000

real = [r for r in rows("real-fast.jsonl") if r.get("kind") == "batch"]
real_today = statistics.median(t for r in real if r["label"].startswith("bun+machine") for t in r["taskMs"]) / 1000
real_now = statistics.median(t for r in real if r["label"].startswith("isolate") for t in r["taskMs"]) / 1000
real_passed = sum(r["ok"] for r in real)
real_total = sum(r["level"] for r in real)
analysis = json.loads((RESULTS / "real-fast.analysis.json").read_text())
done = sum(r["ok"] for r in analysis)
model_share = sum(r["modelMsPerTask"] * r["ok"] for r in analysis) / sum(r["p50"] * r["ok"] for r in analysis)
usd_per_task = sum(r["usdPerTask"] * r["ok"] for r in analysis) / done

quick = [r for r in levers + final if r.get("kind") == "batch"]
quick_passed = sum(r["ok"] for r in quick)
quick_total = sum(r["level"] for r in quick)

build = json.loads((RESULTS / "slim-build.json").read_text())
full_mb = build["fullEntryBytes"] / 1e6
slim_mb = build["slimEntryBytes"] / 1e6


def t(x, y, s, cls="t", anchor="middle"):
    return f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{s}</text>'


def arrow(x, y1, y2):
    return (
        f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2 - 7}" class="ln"/>'
        f'<polygon points="{x},{y2} {x - 5},{y2 - 8} {x + 5},{y2 - 8}" class="ln-head"/>'
    )


def bottom(y, sandbox):
    return (
        f'<rect x="40" y="{y}" width="190" height="48" rx="8" class="svc"/>' + t(135, y + 30, "AI model")
        + f'<rect x="250" y="{y}" width="190" height="48" rx="8" class="svc"/>' + t(345, y + 30, sandbox)
    )


TODAY = (
    '<svg viewBox="0 0 480 300" role="img" class="pic" aria-label="Today: one always-on Broods server runs every task.">'
    '<rect x="20" y="16" width="440" height="160" rx="12" class="big"/>'
    + t(240, 48, "One Broods server, always on", "t b")
    + "".join(
        f'<rect x="{40 + i * 140}" y="66" width="120" height="48" rx="8" class="task"/>' + t(100 + i * 140, 96, f"task {'ABC'[i]}")
        for i in range(3)
    )
    + t(240, 150, "every task shares one program", "t s")
    + arrow(135, 176, 230)
    + arrow(345, 176, 230)
    + bottom(232, "Shell sandbox")
    + "</svg>"
)

IDEA = (
    '<svg viewBox="0 0 480 300" role="img" class="pic" aria-label="Your idea now: each agent gets its own small worker that stays ready between its tasks; usage is written through one shared line; commands run in a real shell sandbox.">'
    '<rect x="150" y="8" width="180" height="34" rx="17" class="pill"/>'
    + t(240, 31, "a user clicks")
    + "".join(
        arrow(85 + i * 155, 42, 62)
        + f'<rect x="{15 + i * 155}" y="62" width="140" height="64" rx="8" class="worker"/>'
        + t(85 + i * 155, 89, f"agent {'ABC'[i]}", "t b")
        + t(85 + i * 155, 112, "own worker, kept ready", "t s")
        for i in range(3)
    )
    + '<rect x="15" y="136" width="450" height="40" rx="8" class="shared"/>'
    + t(240, 162, "one shared line for usage writes", "t s")
    + arrow(135, 176, 230)
    + arrow(345, 176, 230)
    + bottom(232, "Real shell sandbox")
    + "</svg>"
)


def bar_chart():
    items = [
        ("Today", tpm_today, ""),
        ("Your idea, first try", tpm_first, "bad"),
        ("Your idea, last time", tpm_last, "mid"),
        ("Your idea, now", tpm_now, "hl"),
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
        '<svg viewBox="0 0 480 284" role="img" class="chart" aria-label="'
        f"Tasks finished per minute with 20 users at once: today {tpm_today:.0f}, first try {tpm_first:.0f}, "
        f"last time {tpm_last:.0f}, now {tpm_now:.0f}."
        '">' + "".join(out) + "</svg>"
    )


STYLE = """
:root {
  --bg: #f5f6f8; --panel: #ffffff; --ink: #18212b; --muted: #5b6876; --line: #cdd5de;
  --accent: #0b7a68; --accent-soft: #dcf1ec; --bad: #b42318; --bar: #9aabbd; --mid: #6f8fa8;
  --font: "Schibsted Grotesk", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f141a; --panel: #161d25; --ink: #e5eaef; --muted: #9ca8b4; --line: #2d3946;
    --accent: #47c8b0; --accent-soft: #143b35; --bad: #f2786c; --bar: #566576; --mid: #7b97ad; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0f141a; --panel: #161d25; --ink: #e5eaef; --muted: #9ca8b4; --line: #2d3946;
  --accent: #47c8b0; --accent-soft: #143b35; --bad: #f2786c; --bar: #566576; --mid: #7b97ad; color-scheme: dark;
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
svg .bar.mid { fill: var(--mid); }
svg .bar.bad { fill: var(--bad); opacity: 0.75; }
.nums { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 480px) { .nums { grid-template-columns: 1fr; } }
.num { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.num b { display: block; font-family: var(--mono); font-size: 30px; line-height: 1.2; }
.num span { color: var(--muted); font-size: 15px; }
ol, ul { margin: 0; padding-left: 22px; display: grid; gap: 10px; }
.small { color: var(--muted); font-size: 14px; }
code { font-family: var(--mono); font-size: 0.85em; }
a { color: var(--accent); }
"""

speedup = tpm_now / tpm_last
share_10 = tpm_now_10 / tpm_today_10
share_20 = tpm_now / tpm_today
same_sandbox_gap = 1 - tpm_now / tpm_today_shell

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
<p>Yes, it got a lot faster: {speedup:.1f} times faster than last time.</p>
<p>With 10 users at once it keeps up with today ({share_10 * 100:.0f}% of today's speed); with 20 users it does {share_20 * 100:.0f}%. Put today's server on the same sandbox and your idea is only {same_sandbox_gap * 100:.0f}% behind it. With the real AI model a task takes {real_now:.0f} s, against {real_today:.0f} s today.</p>
</div>
</section>

<section>
<h2>What I measured</h2>
<p>Tasks finished per minute with 20 users at once (higher is better):</p>
<figure class="bars">{bar_chart()}</figure>
</section>

<section>
<h2>The three changes</h2>
<ol>
<li><strong>Keep each agent's worker ready.</strong> Before, every task started a new worker from zero ({start_slim:.2f} s of work each time). Now each agent gets its own worker, which stays ready for that agent's next task. Computer time per task went from {cpu_last:.0f} ms to {cpu_now:.0f} ms.</li>
<li><strong>Run commands in a real shell.</strong> The old sandbox imitated bash in JavaScript. A real shell does the same commands with {sbx_js / sbx_shell:.0f} times less computer time ({sbx_js:.0f} ms down to {sbx_shell:.0f} ms per task).</li>
<li><strong>One shared line for usage writes.</strong> When many workers finished at once, they fought over the same usage record and up to {lost_before * 100:.0f}% of the usage rows were lost. Now they queue for it, and {kept_now * 100:.0f}% of rows arrive, with no speed cost.</li>
</ol>
<p>Each change helps on its own (keeping workers ready: {tpm_warm_only:.0f} a minute; real shell: {tpm_shell_only:.0f}), but only together do they get close to today.</p>
</section>

<section>
<h2>The two designs</h2>
<div class="pair">
<figure><figcaption>Today</figcaption>{TODAY}</figure>
<figure><figcaption>Your idea, now</figcaption>{IDEA}</figure>
</div>
</section>

<section>
<h2>Why 20 users is still a bit slower</h2>
<p>Mostly the sandbox route, not your idea. I ran two checks on the same real-shell sandbox, with 20 users:</p>
<ul>
<li>Today's server: {tpm_today_shell:.0f} tasks a minute, down from {tpm_today:.0f}. Reaching a sandbox this way costs {convex_shell - convex_today:.0f} more database calls per task to book it.</li>
<li>One always-on copy of the worker engine, with no per-agent workers: {tpm_engine:.0f}.</li>
<li>Your idea, one worker per agent: {tpm_now:.0f}.</li>
</ul>
<p>So giving every agent its own worker now costs very little. Two next steps: book the sandbox once per task (the sandbox route books it in the database for every command), and run one worker engine per CPU core. Each agent's worker stands alone, so agents can be spread over cores or machines; today's server can't split that way yet, because its tasks share its memory.</p>
</section>

<section>
<h2>What the research says</h2>
<ul>
<li>Cloudflare, Vercel and Deno don't start a worker from zero for every click either. They keep workers ready and send the next request to the one already running. That is change 1.</li>
<li>Cloudflare's own AI agents keep the agent's loop in a worker that stays ready, and only put code the AI writes into a brand-new worker. That is the part worth keeping fresh for safety.</li>
<li>For commands they all use a real Linux sandbox (a tiny virtual machine), not a JavaScript copy of bash. Firecracker and E2B are open source and run on our own servers.</li>
</ul>
</section>

<section>
<h2>With the real AI model</h2>
<div class="nums">
<div class="num"><b>{real_today:.0f} s</b><span>per task today</span></div>
<div class="num"><b>{real_now:.0f} s</b><span>per task with your idea, now</span></div>
</div>
<p>About {model_share * 100:.0f}% of every task is waiting for the AI to answer, and the AI is almost the whole bill (about ${usd_per_task:.3f} per task).</p>
</section>

<section>
<h2>What it would take to ship</h2>
<ol>
<li>Load only the parts of Broods a task uses ({full_mb:.1f} MB down to {slim_mb:.1f} MB). Tested.</li>
<li>Give each agent its own worker, kept ready, and drop it when the agent goes quiet. Tested, apart from dropping idle ones.</li>
<li>Run commands in tiny virtual machines (Firecracker or E2B) behind the sandbox Broods already talks to. Tested with a plain shell standing in, which protects nothing yet.</li>
<li>Move the rest of what tasks share today (the task queue and the sandbox lock) into shared services, like the usage line. Not built yet.</li>
</ol>
</section>

<section>
<p class="small">Tested on a local copy of Broods only, never on production, on a 4-core machine. {quick_passed} of {quick_total} quick test tasks and {real_passed} of {real_total} real AI tasks passed. Code, raw numbers and research notes with sources: branch <code>claude/project-thread-met53d</code>, folder <code>experiments/v8-core</code> (<code>research.md</code>).</p>
</section>
</main>
"""

OUT.write_text(page)
print(OUT, len(page))
