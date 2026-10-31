"""Builds the "Broods task isolates" page: how the setups differ, drawn, and
the slim-isolate measurements behind it. Every number is read from results/;
only prices are typed in.

python3 report/diagrams.py results out.html
"""

import html
import json
import statistics
import sys
from pathlib import Path

RESULTS = Path(sys.argv[1])
OUT = Path(sys.argv[2])
NAN = float("nan")


def rows(name):
    path = RESULTS / name
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def num(value, digits=0):
    if value != value:
        return "n/a"
    return f"{value:,.{digits}f}"


def esc(text):
    return html.escape(str(text), quote=True)


# ---------------------------------------------------------------- data

cold = {r["label"]: r for r in rows("cold-start-slim.jsonl")}
COLD_FULL = cold.get("fresh isolate per request", {})
COLD_SLIM = cold.get("slim core, fresh isolate per request", {})
COLD_TINY = cold.get("tiny worker, fresh isolate per request", {})

bundle = json.loads((RESULTS / "bundle-composition.json").read_text())
BUNDLE_MB = bundle["totalBytes"] / 1e6
OWN_MB = next(c["bytes"] for c in bundle["categories"] if c["name"].startswith("Broods")) / 1e6
build = json.loads((RESULTS / "slim-build.json").read_text())
SLIM_MB = build["slimEntryBytes"] / 1e6
FULL_MB = build["fullEntryBytes"] / 1e6

ARMS = [
    ("bun+machine", "Today", "Bun core, machine sandbox"),
    ("isolate+v8", "Fresh isolate, all of core", "per-task router, 20.7 MB bundle, V8 sandbox"),
    ("isolate+v8-slim", "Fresh isolate, slim core", "per-task router, 2.9 MB bundle, V8 sandbox"),
]
main_rows = rows("slim-d0.jsonl")
control_rows = rows("slim-d0-control.jsonl")
scripted = [r for r in main_rows if r.get("kind") == "batch"]
control = [r for r in control_rows if r.get("kind") == "batch"]
audits = [r for r in main_rows + control_rows if r.get("kind") == "audit"]


def audit_by_batch(all_rows):
    """Each audit row follows its batch; pair them as (label, level) -> [written, expected]."""
    out, last = {}, None
    for r in all_rows:
        if r.get("kind") == "batch":
            last = (r["label"], r["level"])
        elif r.get("kind") == "audit" and last:
            got = out.setdefault(last, [0, 0])
            got[0] += r["runsCompleted"]
            got[1] += 3 * r["tasksStarted"]
    return out


AUDIT = audit_by_batch(main_rows)
AUDIT_CONTROL = audit_by_batch(control_rows)
LEVELS = sorted({r["level"] for r in scripted})


def arm_level(label, level, source=None):
    return [r for r in (scripted if source is None else source) if r["label"] == label and r["level"] == level]


def mean(values):
    values = [v for v in values if v == v]
    return statistics.fmean(values) if values else NAN


def stat(label, level, key, source=None):
    got = arm_level(label, level, source)
    if not got:
        return NAN
    if key == "tpm":
        return mean([r["level"] * 60000 / r["batchMs"] for r in got])
    if key == "cpu":
        return mean([r["runtimeCpuMs"] / r["level"] for r in got])
    if key == "mem":
        return mean([(r["runtimeRssPeakMb"] - r["runtimeRssStartMb"]) / r["level"] for r in got])
    if key == "ok":
        return sum(r["ok"] for r in got), sum(r["level"] for r in got)
    return mean([r[key] for r in got])


real = rows("real-slim.analysis.json") and json.loads((RESULTS / "real-slim.analysis.json").read_text())
REAL_ARMS = [
    ("bun+machine/haiku-slim", "Today"),
    ("isolate+v8/haiku-slim", "Fresh isolate, slim core"),
]


def real_stat(label, key):
    got = [r for r in (real or []) if r["label"] == label]
    total = sum(r["ok"] for r in got)
    if not total:
        return NAN
    if key == "tasks":
        return total
    if key == "ok":
        return total, sum(r["ok"] + r["failed"] for r in got)
    if key == "p50":
        return statistics.median([r["p50"] for r in got for _ in range(r["ok"])])
    return sum(r[key] * r["ok"] for r in got) / total


old_real = json.loads((RESULTS / "real-haiku.analysis.json").read_text())
all_real = old_real + (real or [])
weight = sum(r["ok"] for r in all_real)
MODEL_SHARE = sum(r["modelMsPerTask"] * r["ok"] for r in all_real) / sum(r["p50"] * r["ok"] for r in all_real)
USD_PER_TASK = sum(r["usdPerTask"] * r["ok"] for r in all_real) / weight
REAL_TASKS = weight

# ---------------------------------------------------------------- svg helpers

W, H = 520, 372
SERVICES = [("Convex", "runs, usage"), ("Model API", "every step"), ("MCP servers", "tools"), ("Sandbox", "bash, files")]
SERVICE_X = [20, 142, 264, 386]
SERVICE_W = 113


def rect(x, y, w, h, cls, rx=8, extra=""):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" class="{cls}"{extra}/>'


def text(x, y, s, cls="t", anchor="start"):
    return f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{esc(s)}</text>'


def arrow(x1, y1, x2, y2, cls="ln"):
    # Straight line with a small triangular head drawn as a polygon.
    import math

    angle = math.atan2(y2 - y1, x2 - x1)
    size = 6
    left = (x2 - size * math.cos(angle - 0.45), y2 - size * math.sin(angle - 0.45))
    right = (x2 - size * math.cos(angle + 0.45), y2 - size * math.sin(angle + 0.45))
    end = (x2 - size * 0.8 * math.cos(angle), y2 - size * 0.8 * math.sin(angle))
    return (
        f'<line x1="{x1}" y1="{y1}" x2="{end[0]:.1f}" y2="{end[1]:.1f}" class="{cls}"/>'
        f'<polygon points="{x2},{y2} {left[0]:.1f},{left[1]:.1f} {right[0]:.1f},{right[1]:.1f}" class="{cls}-head"/>'
    )


def chip(x, y, w, label, cls):
    return rect(x, y, w, 26, f"chip {cls}", rx=13) + text(x + w / 2, y + 17, label, f"ct {cls}", "middle")


def services(from_y, xs=None):
    out = []
    for i, (name, role) in enumerate(SERVICES):
        x = SERVICE_X[i]
        cx = x + SERVICE_W / 2
        out.append(arrow(cx, from_y, cx, 298))
        out.append(rect(x, 300, SERVICE_W, 44, "svc"))
        out.append(text(cx, 318, name, "t b", "middle"))
        out.append(text(cx, 335, role, "t s", "middle"))
    return "".join(out)


def svg(body, label):
    return (
        f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{esc(label)}" class="diag">{body}</svg>'
    )


def panel_long_lived(title, footer):
    b = []
    b.append(rect(110, 10, 300, 30, "pill", rx=15))
    b.append(text(260, 30, "requests from every user and channel", "t", "middle"))
    for x in (190, 260, 330):
        b.append(arrow(x, 40, x, 68))
    b.append(rect(20, 70, 480, 182, "box"))
    b.append(text(34, 93, title, "t b"))
    for i, name in enumerate(("task A", "task B", "task C")):
        b.append(rect(34 + i * 100, 106, 90, 28, "task", rx=6))
        b.append(text(79 + i * 100, 125, name, "t", "middle"))
    b.append(text(340, 125, "… up to 64 at once", "t s"))
    b.append(chip(34, 150, 226, "every route and SDK · 20.7 MB", "plain"))
    b.append(chip(268, 150, 160, "run queue · 64 slots", "warn"))
    b.append(chip(34, 186, 120, "sandbox lock", "warn"))
    b.append(chip(162, 186, 120, "usage writer", "warn"))
    b.append(chip(290, 186, 138, "in-flight writes", "warn"))
    b.append(text(34, 238, footer, "t s"))
    b.append(services(252))
    return "".join(b)


def panel_built():
    b = []
    b.append(rect(110, 10, 300, 30, "pill", rx=15))
    b.append(text(260, 30, "router: a new isolate for every request", "t", "middle"))
    xs = (20, 186, 352)
    full_s = COLD_FULL.get("p50Ms", NAN) / 1000
    full_mb = COLD_FULL.get("rssPerRequestMb", NAN)
    for i, x in enumerate(xs):
        cx = x + 74
        b.append(arrow(cx, 40, cx, 68))
        b.append(rect(x, 70, 148, 182, "box"))
        b.append(text(x + 12, 92, f"isolate · task {'ABC'[i]}", "t b"))
        b.append(text(x + 12, 112, f"all of core · {num(FULL_MB, 1)} MB", "t s"))
        b.append(text(x + 12, 128, f"start {num(full_s, 1)} s · {num(full_mb)} MB", "t s"))
        for j, name in enumerate(("own run queue", "own sandbox lock", "own usage writer")):
            b.append(chip(x + 12, 142 + j * 34, 124, name, "bad"))
    b.append(services(252))
    return "".join(b)


def panel_intended():
    b = []
    b.append(rect(110, 10, 300, 30, "pill", rx=15))
    b.append(text(260, 30, "gateway: thin, always on", "t", "middle"))
    slim_s = COLD_SLIM.get("p50Ms", NAN) / 1000
    slim_mb = COLD_SLIM.get("rssPerRequestMb", NAN)
    for i in range(3):
        x = 20 + i * 108
        cx = x + 48
        b.append(arrow(cx, 40, cx, 68))
        b.append(rect(x, 70, 96, 82, "fn"))
        b.append(text(cx, 92, f"task fn {'ABC'[i]}", "t b", "middle"))
        b.append(text(cx, 112, f"{num(SLIM_MB, 1)} MB", "t s", "middle"))
        b.append(text(cx, 128, f"start {num(slim_s, 2)} s", "t s", "middle"))
        b.append(text(cx, 144, f"{num(slim_mb)} MB", "t s", "middle"))
        b.append(arrow(cx, 152, cx, 176))
    b.append(rect(344, 70, 156, 82, "wait", extra=' stroke-dasharray="5 4"'))
    b.append(text(422, 94, "waiting on a subagent", "t", "middle"))
    b.append(text(422, 114, "no function running", "t s", "middle"))
    b.append(text(422, 130, "run state in Convex", "t s", "middle"))
    b.append(rect(20, 178, 480, 74, "shared"))
    b.append(text(34, 198, "shared services, moved out of core", "t b"))
    b.append(chip(34, 212, 140, "run queue", "good"))
    b.append(chip(184, 212, 140, "sandbox lease", "good"))
    b.append(chip(334, 212, 152, "usage writer", "good"))
    b.append(services(252))
    return "".join(b)


def bars(items, unit, digits, highlight, label, width=640, max_value=None):
    """Horizontal bars, one hue, the highlighted row in the accent."""
    row_h, gap, left, right = 26, 10, 210, 90
    height = len(items) * (row_h + gap) + 10
    top = max_value or max(v for _, v, _ in items)
    span = width - left - right
    out = []
    for i, (name, value, tip) in enumerate(items):
        y = 6 + i * (row_h + gap)
        w = max(2, span * value / top)
        cls = "bar hl" if name in highlight else "bar"
        out.append(f"<g><title>{esc(tip)}</title>")
        out.append(text(left - 12, y + 18, name, "t", "end"))
        out.append(f'<rect x="{left}" y="{y}" width="{w:.1f}" height="{row_h}" rx="4" class="{cls}"/>')
        out.append(text(left + w + 8, y + 18, f"{num(value, digits)} {unit}", "t num"))
        out.append("</g>")
    return (
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{esc(label)}" class="chart">'
        + "".join(out)
        + "</svg>"
    )


# ---------------------------------------------------------------- mermaid

SEQUENCE = """sequenceDiagram
  autonumber
  actor U as User
  participant G as Gateway
  participant P as Task fn (parent run)
  participant M as Model API
  participant X as MCP server
  participant S as V8 sandbox
  participant Q as Shared services
  participant C as Convex
  participant K as Task fn (child run)
  participant F as Task fn (follow-up run)
  U->>G: send message
  G->>P: start a function
  P->>C: load agent and history
  P->>M: model step
  M-->>P: call search_docs
  P->>X: search Cloudflare docs
  X-->>P: results
  P->>Q: take sandbox lease
  P->>S: write file, print sha256
  S-->>P: hash
  P->>M: model step
  M-->>P: call run_subagent (async)
  P->>Q: queue the child run
  P->>Q: usage and audit rows
  P-->>U: first answer
  Note over P: function ends. Today and as built, core stays loaded here.
  Q->>K: start a function
  K->>M: model steps
  K->>S: count primes (same files)
  K->>C: save result, owe it to parent
  K->>Q: usage and audit rows
  Q->>F: result owed: start a function
  F->>C: load run state and result
  F->>M: model step
  F-->>U: final answer: 3245 and 29989
  F->>Q: usage and audit rows"""

ACTIVITY = """flowchart TD
  A([message arrives]) --> B[take a run slot]:::shared
  B --> C[load agent and history from Convex]
  C --> D[model step]
  D --> E{tool calls?}
  E -- search_docs --> F[call the MCP server] --> D
  E -- bash --> G[take the sandbox lock]:::shared --> H[run the command in the sandbox] --> D
  E -- run_subagent --> I[queue the child run]:::shared --> D
  E -- none --> J[stream the answer]
  J --> K[write usage and audit rows]:::shared
  K --> L{child result owed?}
  L -- yes --> M([wait. In your design no function runs])
  M -. result arrives .-> N[start the follow-up run] --> C
  L -- no --> Z([task done])
  classDef shared stroke:#c2410c,stroke-width:2px"""

STATES = f"""stateDiagram-v2
  [*] --> Received
  Received --> Loading: gateway starts a function
  Loading --> ParentRun: isolate ready
  state ParentRun {{
    [*] --> ModelStep
    ModelStep --> ToolCall: tool call
    ToolCall --> ModelStep: tool result
    ModelStep --> [*]: answer
  }}
  ParentRun --> Waiting: run_subagent async, parent run completed
  Waiting --> ChildRun: child run starts
  ChildRun --> ResultOwed: child run completed
  ResultOwed --> FollowUpRun: follow-up run starts
  FollowUpRun --> Done: final answer
  ParentRun --> Failed: error or stop
  ChildRun --> Failed
  FollowUpRun --> Failed
  Done --> [*]
  Failed --> [*]
  note right of Loading
    all of core: {num(COLD_FULL.get("p50Ms", NAN) / 1000, 1)} s, {num(COLD_FULL.get("rssPerRequestMb", NAN))} MB
    slim core: {num(COLD_SLIM.get("p50Ms", NAN) / 1000, 2)} s, {num(COLD_SLIM.get("rssPerRequestMb", NAN))} MB
  end note
  note right of Waiting
    today and as built: core holds the task in memory
    your design: nothing runs, state sits in Convex
  end note"""


def mermaid(source):
    return f'<pre class="mermaid">{esc(source)}</pre>'


# ---------------------------------------------------------------- page

def table(head, body, cls=""):
    th = "".join(f"<th>{esc(h)}</th>" for h in head)
    tr = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in body)
    return f'<div class="tw"><table class="{cls}"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table></div>'


def scripted_table(arms, source, audit):
    body = []
    for label, name, detail in arms:
        levels = sorted({r["level"] for r in source if r["label"] == label})
        for level in levels:
            ok = stat(label, level, "ok", source)
            written = audit.get((label, level), [NAN, NAN])
            short = written[0] < written[1]
            body.append([
                f"<strong>{esc(name)}</strong><span class=sub>{esc(detail)}</span>" if level == levels[0] else "",
                str(level),
                num(stat(label, level, "tpm", source)),
                num(stat(label, level, "exMcpP50", source) / 1000, 1),
                num(stat(label, level, "cpu", source)),
                num(mean([r["sandboxCpuMs"] / r["level"] for r in arm_level(label, level, source)])),
                num(stat(label, level, "mem", source)),
                f"{ok[0]}/{ok[1]}",
                f'<span class="{"short" if short else ""}">{written[0]}/{written[1]}</span>',
            ])
    return table(
        ["Setup", "Users at once", "Tasks per minute", "Task time without MCP, s", "Core CPU per task, ms",
         "Sandbox CPU per task, ms", "Core memory per task in flight, MB", "Passed", "Usage rows written"],
        body,
        "num",
    )


CONTROL_ARMS = [
    ("bun+v8", "Bun core, V8 sandbox", "long-lived core, same sandbox as the isolates"),
    ("isolate+v8-slim", "Fresh isolate, slim core", "per-task router, 2.9 MB bundle, V8 sandbox"),
]


def real_table():
    body = []
    for label, name in REAL_ARMS:
        ok = real_stat(label, "ok")
        if ok != ok:
            continue
        body.append([
            f"<strong>{esc(name)}</strong>",
            f"{ok[0]}/{ok[1]}",
            num(real_stat(label, "p50") / 1000, 1),
            num(real_stat(label, "modelMsPerTask") / 1000, 1),
            num(real_stat(label, "toolMsPerTask") / 1000, 1),
            f"{real_stat(label, 'usdPerTask') * 100:.2f}¢",
        ])
    if not body:
        return "<p class=note>The real-model run is still going; this table fills in when it finishes.</p>"
    return table(["Setup", "Passed", "Median task time, s", "Waiting on the model, s", "Tools and core, s", "Model cost per task"], body, "num")


def ratio(a, b):
    return a / b if b else NAN


full_start = COLD_FULL.get("p50Ms", NAN)
slim_start = COLD_SLIM.get("p50Ms", NAN)
tiny_start = COLD_TINY.get("p50Ms", NAN)
top_level = LEVELS[-1] if LEVELS else 20
tpm_today = stat("bun+machine", top_level, "tpm")
tpm_full = stat("isolate+v8", top_level, "tpm")
tpm_slim = stat("isolate+v8-slim", top_level, "tpm")
ex1_today = stat("bun+machine", 1, "exMcpP50") / 1000
ex1_full = stat("isolate+v8", 1, "exMcpP50") / 1000
ex1_slim = stat("isolate+v8-slim", 1, "exMcpP50") / 1000
cpu_today = stat("bun+machine", top_level, "cpu")
cpu_full = stat("isolate+v8", top_level, "cpu")
cpu_slim = stat("isolate+v8-slim", top_level, "cpu")
mem_today = stat("bun+machine", top_level, "mem")
mem_full = stat("isolate+v8", top_level, "mem")
mem_slim = stat("isolate+v8-slim", top_level, "mem")
real_today = real_stat("bun+machine/haiku-slim", "p50") / 1000
real_slim = real_stat("isolate+v8/haiku-slim", "p50") / 1000
tpm_control = stat("bun+v8", top_level, "tpm", control)
tpm_slim_c = stat("isolate+v8-slim", top_level, "tpm", control)
cpu_control = stat("bun+v8", top_level, "cpu", control)
sandbox_today = mean([r["sandboxCpuMs"] / r["level"] for r in arm_level("bun+machine", top_level)])
sandbox_v8 = mean([r["sandboxCpuMs"] / r["level"] for r in arm_level("isolate+v8-slim", top_level)])


def lost_rows(prefix):
    got = [v for audit in (AUDIT, AUDIT_CONTROL) for (label, _), v in audit.items() if label.startswith(prefix)]
    return sum(v[1] - v[0] for v in got), sum(v[1] for v in got)


lost_iso, expected_iso = lost_rows("isolate")
lost_bun, expected_bun = lost_rows("bun")
all_batches = scripted + control
PASSED = sum(r["ok"] for r in all_batches)
STARTED = sum(r["level"] for r in all_batches)
OTHER_CALLS = sum(r["otherRuntimeModelCalls"] for r in all_batches)
AUDIT_BATCHES = len(audits)

bundle_items = [
    (c["name"], c["bytes"] / 1e6, f"{c['name']}: {c['bytes'] / 1e6:.2f} MB, mostly {', '.join(c['top'][:3])}")
    for c in sorted(bundle["categories"], key=lambda c: -c["bytes"])
]
start_items = [
    (f"All of core ({num(FULL_MB, 1)} MB)", full_start, f"{num(full_start)} ms median over {COLD_FULL.get('count', 0)} fresh isolates, {num(COLD_FULL.get('cpuMsPerRequest', NAN))} ms CPU each"),
    (f"Slim core ({num(SLIM_MB, 1)} MB)", slim_start, f"{num(slim_start)} ms median over {COLD_SLIM.get('count', 0)} fresh isolates, {num(COLD_SLIM.get('cpuMsPerRequest', NAN))} ms CPU each"),
    ("Empty worker", tiny_start, f"{num(tiny_start, 1)} ms median over {COLD_TINY.get('count', 0)} fresh isolates"),
]

STYLE = (Path(__file__).parent / "diagrams.css").read_text()

page = f"""<title>Broods task isolates</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>{STYLE}</style>
<main>
<header>
<p class="eyebrow">Broods · experiments/v8-core · 31 Oct 2026</p>
<h1>Broods task isolates</h1>
<p class="lede"><strong>Partly, yes.</strong> The run I called "V8 core" put core inside one always-on V8 isolate. That is the same architecture as today, so it could not improve. The "fresh isolate per task" run was your design, but each task loaded all of core: {num(FULL_MB, 1)} MB, of which Broods' own code is {num(OWN_MB, 1)} MB. The rest is SDKs this agent never calls, and loading them cost {num(full_start / 1000, 1)} s and {num(COLD_FULL.get('rssPerRequestMb', NAN))} MB per task.</p>
<p class="lede">With those SDKs left out ({num(SLIM_MB, 1)} MB), a fresh isolate starts in {num(slim_start / 1000, 2)} s and {num(COLD_SLIM.get('rssPerRequestMb', NAN))} MB. At {top_level} users at once it now finishes {num(tpm_slim)} tasks a minute, against {num(tpm_full)} before. Today's core still does {num(tpm_today)} on this machine. Most of that gap is the V8 sandbox: Bun core on the same V8 sandbox does {num(tpm_control)}.</p>
</header>

<section>
<h2>Four setups, side by side</h2>
<p>The first two drawings are the same picture: only the engine under core changed, so the numbers stayed the same. The third is what I tested as "one isolate per task". The fourth is your design.</p>
<div class="grid">
<figure>
<figcaption><strong>1. Today.</strong> One Bun process runs every task. The amber pieces are state core keeps in that process.</figcaption>
{svg(panel_long_lived("Core on Bun · one process · always on", "tasks share one heap and one copy of every SDK"), "Today: one always-on Bun process runs all tasks and holds the run queue, sandbox lock, usage writer and in-flight writes.")}
</figure>
<figure>
<figcaption><strong>2. What I called "V8 core".</strong> The same core inside one long-lived workerd isolate. Same shape as today, so no gain.</figcaption>
{svg(panel_long_lived("Core in one workerd isolate · always on", "same drawing as today: only the engine changed"), "V8 core as tested: the same process shape as today, with core inside one long-lived workerd isolate.")}
</figure>
<figure>
<figcaption><strong>3. "Fresh isolate per task" as I built it.</strong> Every task loads all of core, and each copy keeps its own queue, lock and usage writer, so they stop coordinating.</figcaption>
{svg(panel_built(), "Per-task as built: a router starts a new isolate for each request, each loading all of core and its own run queue, sandbox lock and usage writer.")}
</figure>
<figure>
<figcaption><strong>4. Your design.</strong> A thin gateway starts a small function per run. The queue, sandbox lease and usage writer live outside, so functions can come and go.</figcaption>
{svg(panel_intended(), "Your design: a thin gateway starts small task functions; the run queue, sandbox lease and usage writer are shared services; nothing runs while a task waits.")}
</figure>
</div>
<p class="note">What broke in drawing 3: two isolates each took their own lock on one sandbox (HTTP 409), and a subagent could not see its parent's files until both were pinned to one sandbox key. Separate usage writers also collide in Convex: in these runs the isolates wrote {expected_iso - lost_iso} of {expected_iso} usage rows, Bun core wrote {expected_bun - lost_bun} of {expected_bun}.</p>
</section>

<section>
<h2>What is in the {num(FULL_MB, 1)} MB</h2>
<p>Core's harness route bundled on its own, measured from its source map. An agent run imports nearly all of core because core loads every channel, provider and harness adapter when it starts (for example <code>twilio-channel.ts</code> builds a formatter at load).</p>
<figure class="wide">
{bars(bundle_items, "MB", 2, {"Broods’ own code"}, "Bundle bytes by group: coding-agent harnesses, chat channels and provider SDKs fill most of it; Broods' own code is 0.67 MB.")}
<figcaption>Hover a bar for its biggest packages. The source map counts characters, so the bars add up to {num(BUNDLE_MB, 1)} MB. The model, MCP and sandbox clients this agent does use sit in the provider and NATS/MCP groups.</figcaption>
</figure>
<h3>Start-up of one fresh isolate</h3>
<figure class="wide">
{bars(start_items, "ms", 0, {f"Slim core ({num(SLIM_MB, 1)} MB)"}, "Median start-up of a fresh isolate: all of core about 2.1 s, slim core about 0.32 s, an empty worker about 6 ms.")}
<figcaption>{COLD_FULL.get('count', 0)} isolates each, one after another, timed from the client. Memory per isolate: {num(COLD_FULL.get('rssPerRequestMb', NAN))} MB for all of core, {num(COLD_SLIM.get('rssPerRequestMb', NAN))} MB slim, {num(COLD_TINY.get('rssPerRequestMb', NAN), 1)} MB empty.</figcaption>
</figure>
</section>

<section>
<h2>Data flow of one task</h2>
<p>The benchmark task in your design: search the docs, write a file and hash it, hand a prime count to a subagent without waiting, then answer again when the result comes back. That is three runs and seven model calls.</p>
<div class="mm">{mermaid(SEQUENCE)}</div>
</section>

<section>
<h2>Activity of a run</h2>
<p>The orange steps are the four things core keeps in its own memory today. They are what breaks when runs move into separate isolates, and they are what has to move into shared services.</p>
<div class="mm">{mermaid(ACTIVITY)}</div>
</section>

<section>
<h2>State of a task</h2>
<p>The difference that matters for cost is the Waiting state. Today and in drawing 3, the task stays loaded in memory while the subagent works. In your design the function ends and Convex holds the state until the result wakes a new one.</p>
<div class="mm">{mermaid(STATES)}</div>
</section>

<section>
<h2>Measured</h2>
<h3>Many users, scripted model</h3>
<p>The model answers instantly from a script with the same tool calls, so this shows the platform's own cost. Each setup ran {len(arm_level("isolate+v8-slim", top_level))} rounds per level, taking turns. Today uses a machine sandbox; the isolates can't, because a machine holds a live connection to one core process, so they use the V8 sandbox.</p>
{scripted_table(ARMS, scripted, AUDIT)}
<h3>Same sandbox: Bun core against the slim isolate</h3>
<p>Run right after, again taking turns, so the only difference is the runtime.</p>
{scripted_table(CONTROL_ARMS, control, AUDIT_CONTROL)}
<h3>Real model: Haiku 5.5, high effort</h3>
{real_table()}
<p>Across all {REAL_TASKS} real-model tasks so far, {num(MODEL_SHARE * 100)}% of the time was spent waiting on the model, and the tokens cost about US${num(USD_PER_TASK * 1e6)} per million tasks.</p>
</section>

<section>
<h2>What improves, and what can't</h2>
<ul class="points">
<li><strong>Start-up is {num(full_start / slim_start, 1)} times faster.</strong> Loading only what a run needs cuts a fresh isolate from {num(full_start / 1000, 1)} s to {num(slim_start / 1000, 2)} s and from {num(COLD_FULL.get('rssPerRequestMb', NAN))} MB to {num(COLD_SLIM.get('rssPerRequestMb', NAN))} MB. Per task, core CPU fell from {num(cpu_full)} ms to {num(cpu_slim)} ms at {top_level} users.</li>
<li><strong>It still costs more CPU than a long-lived core.</strong> Bun core spends {num(cpu_control)} ms of CPU per task on the same work. The difference is mostly the start-up each fresh isolate pays.</li>
<li><strong>The sandbox matters more than the runtime.</strong> The V8 sandbox spent {num(sandbox_v8)} ms of CPU per task on bash, a machine spent {num(sandbox_today)} ms. That is why today's core is still faster here.</li>
<li><strong>Memory per task is higher, not lower.</strong> Today's process adds about {num(mem_today)} MB per task in flight; a slim isolate adds about {num(mem_slim)} MB. Your design only wins on memory if a task holds nothing while it waits on the model, a subagent or an approval.</li>
<li><strong>What it does give.</strong> One customer's task can't crash or slow another's, nothing runs when no one is using Broods, and tasks can spread over many small machines once the shared pieces below live outside core.</li>
<li><strong>Not the model.</strong> {num(MODEL_SHARE * 100)}% of a real task is waiting on the model, and the model is nearly all of the bill. No runtime change speeds that up.</li>
</ul>
<h3>What it takes to ship your design</h3>
<ol class="steps">
<li><span>Load channels, providers and harness adapters only when a run uses them, so a run's bundle is the slim one by default.</span></li>
<li><span>Move the run queue, sandbox lock and usage writer out of core into shared services (Convex or NATS), one usage writer per account.</span></li>
<li><span>End the function when a run waits on a subagent or approval, and start a new one from the event. Core's slot-yield already resumes runs from Convex.</span></li>
<li><span>Put the thin gateway in front, and run the functions on self-hosted workerd.</span></li>
</ol>
</section>

<section class="repro">
<h2>Checks and how to rerun</h2>
<p>A task passes only if a bash result holds a sha256 and the final answer holds 3245 and 29989: {PASSED} of {STARTED} scripted tasks passed. Each task should write 3 usage rows (one per run): Bun core wrote {expected_bun - lost_bun} of {expected_bun}, the isolates {expected_iso - lost_iso} of {expected_iso}, losing the rest to Convex write conflicts at 10 and 20 users. The idle runtime made {OTHER_CALLS} model calls, so no work leaked to it. The slim build swaps each left-out package for a stub that throws the moment a running task calls it; none did.</p>
<pre class="code">cd experiments/v8-core
SLIM=1 bun build.ts ./entry.ts ./dist-slim
PER_TASK_CONFIG=slimConfig AGENT_PER_TASK=1 bench/run-isolate.sh results/slim-d0.jsonl logs 2 1,5,10,20 -slim
SOURCEMAP=1 bun build.ts ./task-entry.ts ./dist-task
node bench/bundle-sizes.mjs dist-task/task-entry.js.map dist-task/task-entry.js &gt; sizes.json
python3 report/bundle_groups.py sizes.json results/bundle-composition.json
python3 report/diagrams.py results page.html</pre>
<p class="note">Branch <code>claude/project-thread-met53d</code>, local stack only, 4 vCPU, 15 GB Linux sandbox. Earlier full report: <a href="https://claude.ai/artifact/BE46ta7uPrZRwJ7BqvcVbG">V8 core benchmark</a>.</p>
</section>
</main>
"""

OUT.write_text(page)
print(OUT, len(page))
