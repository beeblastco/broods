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


def db_cpu(source, label, level=20):
    # Database container CPU per task, every task of the arm's runs at that level.
    picked = [r for r in source if r.get("kind") == "convexCpu" and r["label"] == label and r["level"] == level]
    return sum(r["ms"] for r in picked) / sum(r["tasks"] for r in picked)


def calls(source, label, level=20):
    return statistics.fmean(r["convexCallsPerTask"] for r in batches(source, label, level))


old = rows("slim-d0.jsonl")
levers = rows("fast-d0.jsonl")
final = rows("fast-final.jsonl")
db = rows("db-final.jsonl")
db_old = rows("db-before.jsonl")

# Page v4: "now" is the run after the database work; "before" is page v3's run.
tpm_today = per_minute(db, "bun+machine")
tpm_now = per_minute(db, "isolate+v8-fast")
tpm_first = per_minute(old, "isolate+v8")
tpm_before = per_minute(final, "isolate+v8-fast")
share_before = tpm_before / per_minute(final, "bun+machine")

cpu_last = cpu_per_task(old, "isolate+v8-slim")
cpu_v3 = cpu_per_task(final, "isolate+v8-fast")
sbx_js = cpu_per_task(levers, "isolate+v8-warm", "sandboxCpuMs")
sbx_shell = cpu_per_task(levers, "isolate+v8-warm-native", "sandboxCpuMs")
lost_before = 1 - rows_kept([r for r in levers if r.get("tasksStarted") == 41], "isolate+v8-warm-native")
kept_now = rows_kept(db, "isolate+v8-fast")

db_before = db_cpu(db_old, "isolate+v8-fast")
db_now = db_cpu(db, "isolate+v8-fast")
db_today = db_cpu(db, "bun+machine")
db_same = db_cpu(db, "bun+native")
calls_before = calls(final, "isolate+v8-fast")
calls_now = calls(db, "isolate+v8-fast")
calls_today = calls(db, "bun+machine")


def inside(source, label, level=20):
    # Median time per task not spent waiting on the public docs server, in seconds.
    return statistics.fmean(r["exMcpP50"] for r in batches(source, label, level)) / 1000


in_before = inside(final, "isolate+v8-fast")
in_now = inside(db, "isolate+v8-fast")
in_today = inside(db, "bun+machine")
cpu_now = cpu_per_task(db, "isolate+v8-fast")
cpu_today = cpu_per_task(db, "bun+machine")
tpm_today_low = min(20 * 60000 / r["batchMs"] for r in batches(db, "bun+machine", 20))
tpm_today_high = max(20 * 60000 / r["batchMs"] for r in batches(db, "bun+machine", 20))

cold = {r["label"]: r for r in rows("cold-start-slim.jsonl")}
start_full = cold["fresh isolate per request"]["p50Ms"] / 1000
start_slim = cold["slim core, fresh isolate per request"]["p50Ms"] / 1000

REAL = "real-db" if (RESULTS / "real-db.jsonl").exists() else "real-fast"
real = [r for r in rows(f"{REAL}.jsonl") if r.get("kind") == "batch"]
real_today = statistics.median(t for r in real if r["label"].startswith("bun+machine") for t in r["taskMs"]) / 1000
real_now = statistics.median(t for r in real if r["label"].startswith("isolate") for t in r["taskMs"]) / 1000
earlier = [r for r in rows("real-fast.jsonl") if r.get("kind") == "batch" and r["label"].startswith("bun+machine")]
real_today_earlier = statistics.median(t for r in earlier for t in r["taskMs"]) / 1000
real_passed = sum(r["ok"] for r in real)
real_total = sum(r["level"] for r in real)
analysis = json.loads((RESULTS / f"{REAL}.analysis.json").read_text())
done = sum(r["ok"] for r in analysis)
model_share = sum(r["modelMsPerTask"] * r["ok"] for r in analysis) / sum(r["p50"] * r["ok"] for r in analysis)
usd_per_task = sum(r["usdPerTask"] * r["ok"] for r in analysis) / done

quick = [r for r in levers + final + db if r.get("kind") == "batch"]
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
    '<svg viewBox="0 0 480 300" role="img" class="pic" aria-label="Your idea now: each agent gets its own small worker that stays ready between its tasks; usage is written by one shared writer, in batches; commands run in a real shell sandbox.">'
    '<rect x="150" y="8" width="180" height="34" rx="17" class="pill"/>'
    + t(240, 31, "a user clicks")
    + "".join(
        arrow(85 + i * 155, 42, 62)
        + f'<rect x="{15 + i * 155}" y="62" width="140" height="64" rx="8" class="worker"/>'
        + t(85 + i * 155, 89, f"agent {'ABC'[i]}", "t b")
        + t(85 + i * 155, 112, "own worker, ready", "t s")
        for i in range(3)
    )
    + '<rect x="15" y="136" width="450" height="40" rx="8" class="shared"/>'
    + t(240, 162, "one writer for usage writes, in batches", "t s")
    + arrow(135, 176, 230)
    + arrow(345, 176, 230)
    + bottom(232, "Real shell sandbox")
    + "</svg>"
)


def bar_chart():
    items = [
        ("Today", tpm_today, ""),
        ("Your idea, first try", tpm_first, "bad"),
        ("Your idea, before the database work", tpm_before, "mid"),
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
        f"before the database work {tpm_before:.0f}, now {tpm_now:.0f}."
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
@media (min-width: 760px) { .nums.three { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 759px) { .nums.three { grid-template-columns: 1fr; } }
.num { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.num b { display: block; font-family: var(--mono); font-size: 30px; line-height: 1.2; }
.num span { color: var(--muted); font-size: 15px; }
ol, ul { margin: 0; padding-left: 22px; display: grid; gap: 10px; }
.small { color: var(--muted); font-size: 14px; }
code { font-family: var(--mono); font-size: 0.85em; }
a { color: var(--accent); }
"""

share_20 = tpm_now / tpm_today
db_cut = 1 - db_now / db_before
MODAL = "https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds"
HEADLINE = (
    f"Yes. With the database back-and-forth cut, your idea now keeps up with today: "
    f"{tpm_now:.0f} tasks a minute with 20 users at once, against today's {tpm_today:.0f}."
)
today_single = [t / 1000 for r in real if r["label"].startswith("bun+machine") and r["level"] == 1 for t in r["taskMs"]]
REAL_LINE = (
    f"Still call it a tie, not a win: the AI's own speed swings more than the gap. "
    f"Today's single tasks took {min(today_single):.0f} to {max(today_single):.0f} s in this run, "
    f"and the median was {real_today_earlier:.0f} s last time."
)

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
<p>{HEADLINE}</p>
<p>That is {share_20 * 100:.0f}% of today, up from {share_before * 100:.0f}% before this work, and inside the swing between runs (today itself did {tpm_today_low:.0f} and {tpm_today_high:.0f}). The database now does {db_cut * 100:.0f}% less work per task for your idea, about as much as for today's server on the same kind of sandbox.</p>
</div>
</section>

<section>
<h2>What I measured</h2>
<p>Tasks finished per minute with 20 users at once (higher is better):</p>
<figure class="bars">{bar_chart()}</figure>
</section>

<section>
<h2>What Modal does, and what I copied</h2>
<p>Modal runs up to a million sandboxes at once. <a href="{MODAL}">Their post</a> comes down to one rule: keep the database out of the way of making and using a sandbox, and write the bookkeeping later, in batches. Four of their ideas fit Broods:</p>
<ol>
<li><strong>Look it up once, then go straight there.</strong> Modal's app gets a sandbox's address once and sends every command straight to it. Broods now remembers each sandbox's booking: a command on a sandbox it already knows makes no database call, and it checks back once a minute in the background.</li>
<li><strong>Bookkeeping later, not on the way.</strong> In Modal's words: "We have no data stores in the critical path." Broods now notes a sandbox in the database once per task instead of after every command, and adds up a second of command usage into one write.</li>
<li><strong>One writer, in batches.</strong> Modal's machines bundle messages for many sandboxes into one call. Your idea's workers now hand their usage writes to one writer per account, which sends whatever has piled up as one batch. Before, 20 workers fought over the same usage record and the database kept redoing the losers' work.</li>
<li><strong>Book in one step.</strong> Booking a new sandbox took two database trips (look, then claim). Now it takes one, and two tasks racing for the same sandbox both get the same one.</li>
</ol>
</section>

<section>
<h2>The database, per task</h2>
<div class="nums three">
<div class="num"><b>{db_before:.0f} → {db_now:.0f} ms</b><span>database work per task for your idea, {db_cut * 100:.0f}% less (today's server: {db_today:.0f} ms with its test machine, {db_same:.0f} ms with the same sandbox)</span></div>
<div class="num"><b>{calls_before:.0f} → {calls_now:.0f}</b><span>database calls per task (today's server: {calls_today:.0f})</span></div>
<div class="num"><b>{in_before:.1f} → {in_now:.1f} s</b><span>time per task inside Broods, not counting the wait for the docs server (today's server: {in_today:.1f} s)</span></div>
</div>
<p>All at 20 users at once. Most calls that are left are ones every task needs, like taking the task and saving each step; the {calls_now - calls_today:.0f} extra book and note the sandbox.</p>
</section>

<section>
<h2>What is left</h2>
<p>Each task still spends about {in_now - in_today:.0f} s longer inside Broods than today ({in_now:.1f} s against {in_today:.1f} s). In this test that hides behind the wait for the docs server; with the real AI it hides behind the AI. Two causes:</p>
<ul>
<li><strong>The worker engine.</strong> All 20 workers share one CPU core, and each warms up its own copy of Broods, so a task costs about twice the computer time ({cpu_now:.0f} ms against {cpu_today:.0f} ms; the copies are my best explanation, not measured). Fix: one engine per CPU core, agents spread over them.</li>
<li><strong>Booking new sandboxes.</strong> Every new sandbox is still booked before its first command, and here each task makes two (its own and its helper's). Modal hides this with warm pools, sandboxes made before anyone asks. Fix: book the agent's sandbox while the AI is still thinking.</li>
</ul>
</section>

<section>
<h2>The two designs</h2>
<div class="pair">
<figure><figcaption>Today</figcaption>{TODAY}</figure>
<figure><figcaption>Your idea, now</figcaption>{IDEA}</figure>
</div>
</section>

<section>
<h2>With the real AI model</h2>
<div class="nums">
<div class="num"><b>{real_today:.0f} s</b><span>per task today</span></div>
<div class="num"><b>{real_now:.0f} s</b><span>per task with your idea, now</span></div>
</div>
<p>{REAL_LINE} About {model_share * 100:.0f}% of every task is waiting for the AI to answer, and the AI is almost the whole bill (about ${usd_per_task:.3f} per task).</p>
</section>

<section>
<h2>Earlier changes</h2>
<ol>
<li><strong>Keep each agent's worker ready</strong> instead of starting one from zero for every task: computer time per task went from {cpu_last:.0f} ms to {cpu_v3:.0f} ms.</li>
<li><strong>Run commands in a real shell</strong> instead of a JavaScript copy of bash: {sbx_js / sbx_shell:.0f} times less computer time.</li>
<li><strong>One shared line for usage writes</strong>: before it, about {lost_before * 100:.0f}% of the usage rows were lost at 20 users; now {kept_now * 100:.0f}% arrive.</li>
</ol>
</section>

<section>
<h2>What it would take to ship</h2>
<ol>
<li>Load only the parts of Broods a task uses ({full_mb:.1f} MB down to {slim_mb:.1f} MB). Tested.</li>
<li>Give each agent its own worker, kept ready, and drop it when the agent goes quiet. Tested, apart from dropping idle ones.</li>
<li>The database changes above. Built into Broods on this branch with tests; they help today's server too.</li>
<li>Run commands in tiny virtual machines (Firecracker or E2B) behind the sandbox Broods already talks to. Tested with a plain shell standing in, which protects nothing yet.</li>
<li>Move the rest of what tasks share today (the task queue and the sandbox lock) into shared services, like the usage writer. Not built yet.</li>
</ol>
</section>

<section>
<p class="small">Tested on a local copy of Broods only, never on production, on a 4-core machine. {quick_passed} of {quick_total} quick test tasks and {real_passed} of {real_total} real AI tasks passed. Code, raw numbers and research notes with sources: branch <code>claude/project-thread-met53d</code>, folder <code>experiments/v8-core</code> (<code>research.md</code>).</p>
</section>
</main>
"""

OUT.write_text(page)
print(OUT, len(page))
