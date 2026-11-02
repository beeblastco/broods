"""Builds the short, plain page on the worker-per-task idea: where it stands
after the speed-up work. Every number is read from results/; only prices and
the bundle size come from files written by the build. Version 5 leads with
the two ideas tried after the database work (two-ideas, warm-reps).

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

ideas = rows("two-ideas.jsonl")
warm = [r for r in rows("warm-reps.jsonl") if r.get("kind") == "batch"]

quick = [r for r in levers + final + db + ideas if r.get("kind") == "batch"]
quick_passed = sum(r["ok"] for r in quick)
quick_total = sum(r["level"] for r in quick)

build = json.loads((RESULTS / "slim-build.json").read_text())
full_mb = build["fullEntryBytes"] / 1e6
slim_mb = build["slimEntryBytes"] / 1e6

# Page v5: one run, every arm interleaved, 20 users at once unless named.
v5_today = per_minute(ideas, "bun+machine")
v5_now = per_minute(ideas, "isolate+v8-fast")
v5_engines = per_minute(ideas, "isolate+v8-eng3")
v5_book = per_minute(ideas, "isolate+v8-book")
v5_slow_now = per_minute(ideas, "isolate+v8-fast-d1000")
v5_slow_book = per_minute(ideas, "isolate+v8-book-d1000")
busy = statistics.fmean(r["runtimeCpuMs"] / r["batchMs"] for r in batches(ideas, "isolate+v8-fast", 20))
cpu_one = cpu_per_task(ideas, "isolate+v8-fast")
cpu_three = cpu_per_task(ideas, "isolate+v8-eng3")
warm_first = warm[0]["runtimeCpuMs"] / 1000
warm_later = [r["runtimeCpuMs"] / 1000 for r in warm[1:]]
db_v5_today = db_cpu(ideas, "bun+machine")
db_v5_now = db_cpu(ideas, "isolate+v8-fast")


def t(x, y, s, cls="t", anchor="middle"):
    return f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{s}</text>'


def bar_chart():
    items = [
        ("Today", v5_today, ""),
        ("Your idea, as it is", v5_now, "hl"),
        ("+ one engine per CPU core", v5_engines, "mid"),
        ("+ sandbox booked while the AI thinks", v5_book, "mid"),
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
        f"Tasks finished per minute with 20 users at once: today {v5_today:.0f}, your idea as it is {v5_now:.0f}, "
        f"with one engine per CPU core {v5_engines:.0f}, with the sandbox booked early {v5_book:.0f}."
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

db_cut = 1 - db_now / db_before
MODAL = "https://modal.com/blog/scaling-to-1-million-concurrent-sandboxes-in-seconds"

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
<p>I tried both ideas. Neither made your idea faster, so I took them out again.</p>
<p>With 20 users at once, your idea did {v5_now:.0f} tasks a minute as it is, {v5_engines:.0f} with one engine per CPU core, and {v5_book:.0f} with the sandbox booked while the AI thinks. Today's server did {v5_today:.0f} in the same run ({tpm_today:.0f} in the last one; it swings).</p>
</div>
</section>

<section>
<h2>What I measured</h2>
<p>Tasks finished per minute with 20 users at once (higher is better), every setup taking turns in one run, twice:</p>
<figure class="bars">{bar_chart()}</figure>
</section>

<section>
<h2>Why neither helped</h2>
<ul>
<li><strong>More engines.</strong> With 20 users, the one engine was busy only about {busy * 100:.0f}% of the time, so there was no queue for more engines to clear. Three engines only cost more computer time per task ({cpu_three:.0f} ms against {cpu_one:.0f} ms with one).</li>
<li><strong>Booking early.</strong> It takes one quick database call out of the way of each new sandbox. Even with a slower AI (1 second per answer) the gain, {v5_slow_now:.0f} to {v5_slow_book:.0f} tasks a minute, was smaller than the swing between runs.</li>
<li><strong>Warm-up was not the cause either.</strong> My guess last time was that each worker warms up its own copy of Broods. Five rounds on the same workers cost the same computer time ({warm_first:.1f} s for the first round of 20 tasks, then {min(warm_later):.1f} to {max(warm_later):.1f} s).</li>
</ul>
</section>

<section>
<h2>What is left</h2>
<p>Your idea still finishes about {(1 - v5_now / v5_today) * 100:.0f}% fewer tasks a minute than today in this run, and asks the database for a little more work per task ({db_v5_now:.0f} ms against {db_v5_today:.0f} ms). I have now ruled out the engine, the booking and warm-up; I do not have a measured cause for the rest yet. The next step would be to follow one task through both setups, step by step, to see where its extra time goes.</p>
</section>

<section>
<h2>Where it stands</h2>
<ol>
<li><strong>Database work</strong>, from <a href="{MODAL}">Modal's ideas</a> (look up once, bookkeeping later, writes in batches, booking in one step): {db_cut * 100:.0f}% less database work per task for your idea. Built into Broods on this branch with tests; it helps today's server too.</li>
<li><strong>Each agent keeps a ready worker</strong>: computer time per task went from {cpu_last:.0f} ms to {cpu_v3:.0f} ms.</li>
<li><strong>Commands run in a real shell</strong> instead of a JavaScript copy of bash: {sbx_js / sbx_shell:.0f} times less computer time.</li>
<li><strong>One shared writer for usage</strong>: {kept_now * 100:.0f}% of usage rows arrive, against about {(1 - lost_before) * 100:.0f}% before.</li>
<li><strong>With the real AI</strong> it is a tie: {real_today:.0f} s per task today, {real_now:.0f} s with your idea. About {model_share * 100:.0f}% of a task is waiting for the AI, and the AI is almost the whole bill (about ${usd_per_task:.3f} per task).</li>
</ol>
</section>

<section>
<h2>What it would take to ship</h2>
<ol>
<li>Load only the parts of Broods a task uses ({full_mb:.1f} MB down to {slim_mb:.1f} MB). Tested.</li>
<li>Give each agent its own worker, kept ready, and drop it when the agent goes quiet. Tested, apart from dropping idle ones.</li>
<li>The database changes above. In Broods on this branch, with tests.</li>
<li>Run commands in tiny virtual machines (Firecracker or E2B) behind the sandbox Broods already talks to. Tested with a plain shell standing in, which protects nothing yet.</li>
<li>Move the rest of what tasks share today (the task queue and the sandbox lock) into shared services, like the usage writer. Not built yet.</li>
</ol>
</section>

<section>
<p class="small">Tested on a local copy of Broods only, never on production, on a 4-core machine. {quick_passed} of {quick_total} quick test tasks and {real_passed} of {real_total} real AI tasks passed. Code, raw numbers and research notes with sources: branch <code>claude/project-thread-met53d</code>, folder <code>experiments/v8-core</code> (<code>README.md</code>, <code>research.md</code>).</p>
</section>
</main>
"""

OUT.write_text(page)
print(OUT, len(page))
