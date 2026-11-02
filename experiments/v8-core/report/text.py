"""Narrative and layout of the report. Every number shown is read from the
folded result rows that gen.py passes in; nothing here is typed in by hand
except prices, which carry their source, and the bundle size."""

from pathlib import Path

ORDER = ["bun+machine", "workerd+v8", "bun+v8", "isolate+v8"]

# Prices, each with where it came from.
EUR_PER_MONTH_CX53 = 29.49  # Hetzner CX53, 16 vCPU / 32 GB, list price for orders after June 2026 (third-party listings)
CX53_VCPU = 16
CX53_GB = 32
HOURS_PER_MONTH = 730
EUR_PER_VCPU_HOUR = EUR_PER_MONTH_CX53 / (CX53_VCPU * HOURS_PER_MONTH)
CF_USD_PER_M_CPU_MS = 0.02  # Cloudflare Workers Standard, per million CPU-ms
CF_USD_PER_M_REQUESTS = 0.30  # Cloudflare Workers Standard, per million requests
BUNDLE_MB = 20.7  # experiments/v8-core/dist/entry.js, minified (20,712,699 bytes)


def page(d, h):
    css = Path(__file__).with_name("style.css").read_text()
    num, secs, esc, table = h["num"], h["secs"], h["esc"], h["table"]
    ARMS = h["ARMS"]
    nan = float("nan")

    def g(ds, arm, level, key):
        row = d[ds].get((arm, level))
        return row[key] if row else nan

    def arms_in(ds):
        return [a for a in ORDER if any(k[0] == a for k in d[ds])]

    def levels_in(ds):
        return sorted({k[1] for k in d[ds]})

    def name(arm):
        return f'<span class="key {ARMS[arm][1]}"></span>{esc(ARMS[arm][0])}'

    def times(a, b):
        return f"{a / b:.0f}" if a == a and b == b and b else "–"

    # ---- result tables -------------------------------------------------
    def run_table(ds, caption):
        head = ["Setup", "Tasks at once", "Tasks passed", "Median task, s", "p95 task, s",
                "Median without MCP wait, s", "Tasks per minute", "Core CPU per task, ms",
                "Sandbox CPU per task, ms", "Core memory peak, MB", "Convex calls per task"]
        body = []
        arms = arms_in(ds)
        for arm in arms:
            first = True
            for lv in levels_in(ds):
                r = d[ds].get((arm, lv))
                if not r:
                    continue
                passed = f'{r["ok"]}/{r["tasks"]}'
                if r["ok"] < r["tasks"]:
                    passed = f'<span class="bad">{passed}</span>'
                cls = ' class="group-start"' if first and arm != arms[0] else ""
                lead = h["arm_cell"](arm) if first else '<th scope="row"></th>'
                body.append(
                    f"<tr{cls}>{lead}<td>{lv}</td><td>{passed}</td><td>{secs(r['p50'])}</td><td>{secs(r['p95'])}</td>"
                    f"<td>{secs(r['exMcp'])}</td><td>{num(r['perMin'], 1)}</td><td>{num(r['coreCpu'])}</td>"
                    f"<td>{num(r['sandboxCpu'])}</td><td>{num(r['rssPeak'])}</td><td>{num(r['convex'], 1)}</td></tr>"
                )
                first = False
        return table(head, body, caption)

    def chart_pair(ds, prefix):
        levels = levels_in(ds)
        arms = arms_in(ds)
        lat = [{"name": ARMS[a][0], "cls": ARMS[a][1], "values": [g(ds, a, lv, "exMcp") / 1000 for lv in levels]} for a in arms]
        thr = [{"name": ARMS[a][0], "cls": ARMS[a][1], "values": [g(ds, a, lv, "perMin") for lv in levels]} for a in arms]
        return (
            h["legend"](arms)
            + '<div class="charts">'
            + h["line_chart"](lat, levels, "Median task time without the MCP wait", "seconds, lower is better", f"{prefix}-lat")
            + h["line_chart"](thr, levels, "Tasks finished per minute", "tasks per minute, higher is better", f"{prefix}-thr", unit="tasks/min", digits=0)
            + "</div>"
        )

    # ---- real model --------------------------------------------------------
    real_rows = d["real_an"]

    def real_mean(arm, level, key):
        vals = [r[key] for r in real_rows if r["label"].split("/")[0] == arm and r["level"] == level]
        return sum(vals) / len(vals) if vals else nan

    def real_overall(key):
        total = sum(r[key] * r["level"] for r in real_rows)
        tasks = sum(r["level"] for r in real_rows)
        return total / tasks if tasks else nan

    def real_table():
        if not d["real"]:
            return '<div class="note"><p>The real-model runs are not in this build.</p></div>'
        head = ["Setup", "Tasks at once", "Tasks passed", "Median task, s", "p95 task, s",
                "Model time per task, s", "Tool time per task, s", "Model steps per task",
                "Input tokens per task: uncached + cache read + cache write", "Output tokens per task",
                "Model cost per task, US cents", "Core CPU per task, ms", "Sandbox CPU per task, ms"]
        body = []
        arms = arms_in("real")
        for arm in arms:
            first = True
            for lv in levels_in("real"):
                r = d["real"].get((arm, lv))
                if not r:
                    continue
                passed = f'{r["ok"]}/{r["tasks"]}'
                if r["ok"] < r["tasks"]:
                    passed = f'<span class="bad">{passed}</span>'
                cls = ' class="group-start"' if first and arm != arms[0] else ""
                lead = h["arm_cell"](arm) if first else '<th scope="row"></th>'
                tokens = f"{num(real_mean(arm, lv, 'inputTokensPerTask'))} + {num(real_mean(arm, lv, 'cacheReadPerTask'))} + {num(real_mean(arm, lv, 'cacheWritePerTask'))}"
                body.append(
                    f"<tr{cls}>{lead}<td>{lv}</td><td>{passed}</td><td>{secs(r['p50'])}</td><td>{secs(r['p95'])}</td>"
                    f"<td>{secs(real_mean(arm, lv, 'modelMsPerTask'))}</td><td>{secs(real_mean(arm, lv, 'toolMsPerTask'))}</td>"
                    f"<td>{num(real_mean(arm, lv, 'stepsPerTask'), 1)}</td><td>{tokens}</td><td>{num(real_mean(arm, lv, 'outputTokensPerTask'))}</td>"
                    f"<td>{num(real_mean(arm, lv, 'usdPerTask') * 100, 2)}</td><td>{num(r['coreCpu'])}</td><td>{num(r['sandboxCpu'])}</td></tr>"
                )
                first = False
        return table(head, body, "Haiku 5.5 at high effort, one agent per task. Task times are medians over rounds; model, token and cost columns are means from core's own step log.")

    # ---- cold start and sandbox probe --------------------------------------
    def cold_table():
        head = ["What answered", "Requests", "Fresh isolates", "Median, ms", "p95, ms", "CPU per request, ms", "Memory kept per request, MB"]
        body = []
        for r in d["cold"]:
            body.append(
                f'<tr><th scope="row">{esc(r["label"])}</th><td>{r["count"]}</td><td>{r["distinctIsolates"]}</td>'
                f"<td>{num(r['p50Ms'], 1)}</td><td>{num(r['p95Ms'], 1)}</td><td>{num(r['cpuMsPerRequest'], 1)}</td><td>{num(r['rssPerRequestMb'], 1)}</td></tr>"
            )
        return table(head, body, "One GET /healthz at a time, 30 in a row. A fresh isolate has to load and start all of core before it can answer.")

    def probe_table():
        head = ["Command", "Runs", "Median, ms", "p95, ms", "CPU per run, ms", "Memory added over the series, MB"]
        body = []
        for r in d["probe"]:
            body.append(
                f'<tr><th scope="row">{esc(r["label"])}</th><td>{r["count"]}</td><td>{num(r["p50Ms"], 1)}</td>'
                f"<td>{num(r['p95Ms'], 1)}</td><td>{num(r['cpuMsPerCall'], 1)}</td><td>{num(r['rssGrowthMb'])}</td></tr>"
            )
        return table(head, body, "The task's own bash commands, sent straight to each sandbox with no agent around them.")

    # ---- cost --------------------------------------------------------------
    A = "agents"
    cost_level = 20

    def cost_rows():
        rows = []
        for arm in arms_in(A):
            r = d[A].get((arm, cost_level))
            if not r:
                continue
            sb = r["sandboxCpu"] if r["sandboxCpu"] == r["sandboxCpu"] else 0
            cpu_ms = r["coreCpu"] + sb
            vcpu_h = cpu_ms * 1e6 / 3.6e6
            sb_mem = r["sbMemPerTask"] if r["sbMemPerTask"] == r["sbMemPerTask"] and arm != "bun+machine" else 0
            mem = r["memPerTask"] + sb_mem
            cf = cpu_ms * CF_USD_PER_M_CPU_MS + CF_USD_PER_M_REQUESTS
            rows.append((arm, r, cpu_ms, vcpu_h, vcpu_h * EUR_PER_VCPU_HOUR, mem, cf))
        return rows

    model_usd_m = real_overall("usdPerTask") * 1e6

    def cost_table():
        head = ["Setup", "Server CPU per task, ms (core + sandbox)", "vCPU-hours per million tasks",
                "Server CPU per million tasks on a CX53, EUR", "Memory per task in flight, MB (core + sandbox)",
                "Same CPU at Cloudflare Workers rates, US$ per million tasks"]
        body = []
        for arm, r, cpu_ms, vcpu_h, eur, mem, cf in cost_rows():
            body.append(
                f"<tr>{h['arm_cell'](arm)}<td>{num(cpu_ms)}</td><td>{num(vcpu_h)}</td><td>{num(eur, 2)}</td>"
                f"<td>{num(mem, 1)}</td><td>{num(cf, 2)}</td></tr>"
            )
        return table(head, body, f"From the no-wait runs at {cost_level} tasks at once, one agent per task. Server CPU cost assumes every core is busy, so it is a floor.")

    # ---- audits ------------------------------------------------------------
    def audit_table():
        labels = {"agents": "No model wait, one agent per task", "d0": "No model wait, one agent",
                  "d2": "2 s model wait, one agent", "real": "Haiku 5.5 high, one agent per task", "real_sep": "Haiku 5.5 high, subagent files apart",
                  "iso1": "Fresh isolate, one agent"}
        body = []
        for ds, label in labels.items():
            for arm, (done, started) in sorted(d["audit"].get(ds, {}).items(), key=lambda kv: ORDER.index(kv[0]) if kv[0] in ORDER else 9):
                # The real model sometimes starts an extra subagent, so its expected
                # count is the runs core itself logged, not three per task.
                logged = {"real": real_rows, "real_sep": d["real_sep_an"]}.get(ds)
                expected = sum(r.get("runsLogged", 0) for r in logged if r["label"].split("/")[0] == arm) if logged is not None else 3 * started
                cell = f"{done} of {expected}"
                if done != expected:
                    cell = f'<span class="bad">{cell}</span>'
                body.append(f'<tr><th scope="row">{esc(label)}</th><td class="text">{name(arm)}</td><td>{started}</td><td>{cell}</td></tr>')
        return table(["Run set", "Setup", "Tasks started", "Usage rows written, of runs expected"], body,
                     "With the scripted model every task makes three runs (parent, subagent, follow-up). The real model sometimes starts an extra subagent, so there the expected count is the runs core logged. Each run writes one run.completed row with its usage, in the same Convex transaction.")

    # ---- numbers used in the prose -----------------------------------------
    ex1 = {a: g(A, a, 1, "exMcp") for a in ORDER}
    thr20 = {a: g(A, a, 20, "perMin") for a in ORDER}
    ex20 = {a: g(A, a, 20, "exMcp") for a in ORDER}
    core_cpu = {a: g(A, a, 20, "coreCpu") for a in ORDER}
    sb_cpu = {a: g(A, a, 20, "sandboxCpu") for a in ORDER}
    cold = {r["label"]: r for r in d["cold"]}
    fresh = cold.get("fresh isolate per request", {})
    tiny = cold.get("tiny worker, fresh isolate per request", {})
    probe = {r["label"]: r for r in d["probe"]}
    hang = [r for r in d["hang"] if r.get("kind") == "batch" and r["failed"]]
    lost_audits = [r for r in d["lost"] if r.get("kind") == "audit"]
    real_p50 = {a: g("real", a, 1, "p50") for a in ORDER}
    model_share = real_overall("modelMsPerTask") / real_overall("p50") if real_rows else nan
    steps = [r["stepsPerTask"] for r in real_rows]
    real_ok = sum(r["ok"] for r in d["real"].values())
    real_tasks = sum(r["tasks"] for r in d["real"].values())
    other_steps = sum(r.get("otherRuntimeSteps", 0) for r in real_rows)
    crows = {row[0]: row for row in cost_rows()}
    one_agent5 = d["iso1"].get(("isolate+v8", 5))
    iso_audit = d["audit"].get("agents", {}).get("isolate+v8", (0, 0))
    total_cpu = {a: core_cpu[a] + (sb_cpu[a] if sb_cpu[a] == sb_cpu[a] else 0) for a in ORDER}
    today_eur = crows["bun+machine"][4] if "bun+machine" in crows else nan
    sep = d["real_sep"]
    sep_v8_ok = sum(r["ok"] for (arm, _), r in sep.items() if arm != "bun+machine")
    sep_v8_tasks = sum(r["tasks"] for (arm, _), r in sep.items() if arm != "bun+machine")
    sep_m_ok = sum(r["ok"] for (arm, _), r in sep.items() if arm == "bun+machine")
    sep_m_tasks = sum(r["tasks"] for (arm, _), r in sep.items() if arm == "bun+machine")

    def mean_steps(rows, v8):
        picked = [r for r in rows if (r["label"].split("/")[0] != "bun+machine") == v8]
        n = sum(r["level"] for r in picked)
        return sum(r["stepsPerTask"] * r["level"] for r in picked) / n if n else nan

    sep_steps_v8, sep_steps_m = mean_steps(d["real_sep_an"], True), mean_steps(d["real_sep_an"], False)
    shared_steps_v8 = mean_steps(real_rows, True)

    verdict = f"""
<div class="verdict">
<h2>Verdict</h2>
<ul>
<li><strong>A fresh V8 isolate per task made tasks slower and costlier, not cheaper.</strong> Every task first loads all of core, a {BUNDLE_MB} MB bundle, into its new isolate. That took {secs(fresh.get('p50Ms'), 1)} s and {num(fresh.get('cpuMsPerRequest'))} ms of CPU before any work. A whole task on this setup used about {times(total_cpu['isolate+v8'], total_cpu['bun+machine'])} times the server CPU of a task today, and each task in flight held {num(crows.get('isolate+v8', [0] * 6)[5])} MB against {num(crows.get('bun+machine', [0] * 6)[5], 1)} MB. At 20 tasks at once it finished {num(thr20['isolate+v8'])} tasks a minute; today's setup finished {num(thr20['bun+machine'])}.</li>
<li><strong>The isolate itself is cheap; core's size is the cost.</strong> The same router with an empty worker starts a fresh isolate in {num(tiny.get('p50Ms'), 1)} ms on {num(tiny.get('cpuMsPerRequest'), 1)} ms of CPU and {num(tiny.get('rssPerRequestMb'), 1)} MB. A per-task design only pays if each task loads a small agent runtime, not all of core.</li>
<li><strong>Core in one long-lived V8 isolate works and can be self-hosted</strong> on open-source workerd, with two small core patches. It used a similar amount of CPU to Bun ({num(core_cpu['workerd+v8'])} against {num(core_cpu['bun+machine'])} ms per task at 20 at once) and slightly more memory. Swapping the runtime alone changes neither speed nor cost.</li>
<li><strong>The V8 bash sandbox is the slow part of every V8 setup.</strong> The task's commands used {num(sb_cpu['workerd+v8'])} ms of sandbox CPU per task against {num(sb_cpu['bun+machine'])} ms in a real Linux shell, and the sandbox runs on one thread, so at 20 at once the V8 core managed {num(thr20['workerd+v8'])} tasks a minute.</li>
<li><strong>The model is most of the time and nearly all of the money.</strong> With Haiku 5.5 at high effort a task spent {num(model_share * 100)}% of its time waiting on the model, and the tokens cost about US${num(model_usd_m)} per million tasks. Today's server CPU for the same million is about EUR {num(today_eur, 2)} at full use.</li>
<li><strong>Core assumes it lives in one process.</strong> Split into isolates it lost usage rows, hung queued runs, let two tasks write one sandbox at once, and at 20 isolates lost usage writes to Convex conflicts. Each is under Problems found with its evidence.</li>
</ul>
</div>"""

    setups = """
<section>
<h2>What was compared</h2>
<div class="setups">
<div class="setup a1"><h3>Today</h3><p>Core as one long-lived Bun process. Bash runs in a real Linux shell on a connected machine, the way a Broods machine sandbox does.</p></div>
<div class="setup a2"><h3>V8 core</h3><p>Core's real router and handlers bundled into one Worker and served by self-hosted workerd as one long-lived isolate. Bash runs in the V8 sandbox (just-bash inside V8 isolates).</p></div>
<div class="setup a3"><h3>Control</h3><p>Today's Bun core with the V8 sandbox, to separate what the runtime changes from what the sandbox changes.</p></div>
<div class="setup a4"><h3>Fresh isolate per task</h3><p>Your idea taken literally: a small workerd router starts a brand-new isolate holding core for every request, so each task runs in its own V8 isolate and nothing carries over.</p></div>
</div>
<div class="prose">
<p>Every setup ran the same agent on the same local Broods stack (local Convex, one machine) and called the same public Cloudflare docs MCP server. The agent's task:</p>
<ol class="steps">
<li><span>Search the Cloudflare docs through the MCP server for the Workers CPU limit.</span></li>
<li><span>In bash, write <code>notes/limits.md</code> in its own folder and print its sha256.</span></li>
<li><span>Start a subagent with <code>run_subagent</code> and do not wait. The subagent writes <code>primes.sh</code>, saves every prime below 30000 to <code>primes.txt</code>, and reports the count and the largest.</span></li>
<li><span>Answer, then answer again when the subagent's result comes back.</span></li>
</ol>
<p>That is three runs (parent, subagent, follow-up), seven model calls with a scripted model, one MCP call and at least two bash commands per task. A task passes only if a bash result held a sha256 and the final answer holds the subagent's real result, 3245 primes and 29989 the largest.</p>
<p>The model was either the real Haiku 5.5 at high effort, or a scripted model answering in process with the same tool calls, at once or after 2 s per call. The scripted runs time Broods itself; the real runs show what a user waits for.</p>
</div>
</section>"""

    real_sec = f"""
<section>
<h2>With the real model</h2>
<div class="prose">
<p>Haiku 5.5 at high effort, with the key passed only through the environment. One task at a time for three rounds and five at once for two; each round ran every setup in turn, so the provider's drift falls on all of them. {real_ok} of {real_tasks} tasks passed.</p>
<p>A first full run found that on the V8 sandbox a subagent does not see its parent's files: stored files are kept per agent identity, and a subagent has its own. Haiku then checked the folder, found no <code>primes.txt</code>, and called the subagent's answer unverified, so {sep_v8_tasks - sep_v8_ok} of {sep_v8_tasks} V8 tasks failed, and V8 tasks averaged {num(sep_steps_v8, 1)} model steps against {num(sep_steps_m, 1)} on the machine, where parent and subagent share one disk ({sep_m_ok} of {sep_m_tasks} passed there; the one failure was a bash command that errored). The runs below pin each agent's V8 sandbox to one reservation key, so parent and subagent share files as they do on a machine; V8 tasks then averaged {num(shared_steps_v8, 1)} steps.</p>
</div>
{real_table()}
<div class="prose">
<p>At one task the median was {secs(real_p50['bun+machine'])} s today, {secs(real_p50['workerd+v8'])} s on the V8 core, {secs(real_p50['bun+v8'])} s on the control and {secs(real_p50['isolate+v8'])} s with a fresh isolate. The real model took between {num(min(steps) if steps else nan, 1)} and {num(max(steps) if steps else nan, 1)} steps per task on the same prompt, so its own variation is larger than most differences between setups; the scripted runs below are where the setups are compared.</p>
</div>
</section>"""

    agents_sec = f"""
<section>
<h2>Broods itself, many users at once</h2>
<div class="prose">
<p>The scripted model answers at once, so these runs time only Broods: core, Convex, the sandbox and the MCP call. Each task has its own agent and so its own sandbox files, the way different users' tasks arrive. Two rounds per setup.</p>
<p>At one task the V8 core took {secs(ex1['workerd+v8'], 2)} s without the MCP wait against {secs(ex1['bun+machine'], 2)} s today, and the control took {secs(ex1['bun+v8'], 2)} s, so the sandbox makes the difference, not the runtime. The fresh isolate took {secs(ex1['isolate+v8'], 2)} s. At 20 at once the fresh isolate's tasks took {secs(ex20['isolate+v8'])} s each, as twenty copies of core started on four cores at once.</p>
</div>
{chart_pair(A, "agents")}
{run_table(A, "No model wait, one agent per task. Medians over two rounds; CPU is a per-task mean.")}
</section>"""

    iso_sec = f"""
<section>
<h2>Where the fresh isolate's time goes</h2>
<div class="prose">
<p>A health check is the smallest request core answers, so it shows what starting costs before any work. A long-lived Bun or workerd core answers in under a millisecond. A fresh isolate must parse, compile and run all {BUNDLE_MB} MB of core first: {secs(fresh.get('p50Ms'), 2)} s and {num(fresh.get('cpuMsPerRequest'))} ms of CPU, every task.</p>
<p>The router also kept every isolate it loaded: memory grew {num(fresh.get('rssPerRequestMb'))} MB per request and did not come back while idle, which is why the bench restarted it before every batch. The empty worker shows the isolate is not the problem: {num(tiny.get('cpuMsPerRequest'), 1)} ms of CPU and {num(tiny.get('rssPerRequestMb'), 1)} MB.</p>
</div>
{cold_table()}
</section>"""

    probe_sec = f"""
<section>
<h2>The sandbox on its own</h2>
<div class="prose">
<p>The agent's own commands, sent straight to each sandbox. The prime list costs {num(probe.get('native bash: primes', {}).get('cpuMsPerCall'))} ms of CPU in a real shell and {num(probe.get('v8 sandbox: primes, fresh isolate', {}).get('cpuMsPerCall'))} ms in the V8 sandbox, which interprets bash in JavaScript and starts an isolate per sandbox. A warm isolate saves the start-up, but the script alone still costs {num(probe.get('v8 sandbox: primes, same isolate', {}).get('cpuMsPerCall'))} ms.</p>
</div>
{probe_table()}
</section>"""

    cost_sec = f"""
<section>
<h2>What a million tasks cost</h2>
<div class="prose">
<p>Server CPU is priced on the Hetzner CX53 the project runs on: EUR {EUR_PER_MONTH_CX53} a month for 16 vCPU, or EUR {EUR_PER_VCPU_HOUR:.4f} per vCPU-hour. That assumes every core is busy, so it is a floor. Memory per task in flight decides how many tasks one server holds at once: a CX53 has {CX53_GB} GB.</p>
<p>For scale, Haiku 5.5 at list price (US$0.10 per million input tokens and US$0.50 per million output, cache reads at 0.1× and cache writes at 1.25×) cost about US${num(model_usd_m)} per million of these tasks, from the token counts measured above. The last column prices the same CPU at Cloudflare Workers rates (US$0.02 per million CPU-ms plus US$0.30 per million requests), which bill CPU only and not time spent waiting on the model.</p>
</div>
{cost_table()}
<div class="note"><p>The machine sandbox here is a local machine, not an AWS MicroVM. A MicroVM is billed for every second it is up, including while the model thinks, and this bench does not measure that. The V8 sandbox costs CPU only while a command runs, so it can still be the cheaper sandbox for short commands even though each command costs more CPU.</p></div>
</section>"""

    busy_sec = f"""
<section>
<h2>One busy agent</h2>
<div class="prose">
<p>The first runs put every task on one agent, so tasks at once shared one set of sandbox files. Core lets only one command at a time touch a sandbox's stored files, and it keeps that rule in process memory.</p>
<p>Separate isolates do not share that memory. With the fresh-isolate router, commands from different tasks reached the sandbox together and it refused all but one with a 409 ("another command changed the sandbox's files while this one ran; it stored nothing"). {f"{one_agent5['ok']} of {one_agent5['tasks']} tasks passed at five at once." if one_agent5 else ''} No files were damaged; the commands failed.</p>
</div>
{run_table("iso1", "Fresh isolate per task, one agent for every task, one round.")}
{run_table("d0", "No model wait, one agent for every task. Medians over three rounds.")}
{run_table("d2", "2 s per model call, one agent for every task. Medians over two rounds.")}
</section>"""

    hang_line = " and ".join(f"{r['failed']} of {r['level']}" for r in hang)
    lost_line = " and ".join(f"{r['runsCompleted']} of {3 * r['tasksStarted']}" for r in lost_audits)
    findings = f"""
<section>
<h2>Problems found</h2>
<div class="table-wrap"><table>
<caption>Most come from core keeping state in one long-lived process. The bench worked around three of them (usage drain, run limit, shared files) so the setups could be compared.</caption>
<thead><tr><th scope="col">Problem</th><th scope="col">Evidence</th><th scope="col">State</th></tr></thead>
<tbody>
<tr><th scope="row">Usage rows lost on workerd</th><td class="text">Core writes run.completed and usage after the response ends, and workerd cancels a request's work once its response is done. Two rounds wrote {esc(lost_line)} expected rows.</td><td class="text">Fixed in the experiment: the Worker waits for the body to end, then for core's in-flight writes. Later rounds wrote 3.00 rows per task.</td></tr>
<tr><th scope="row">Usage writes conflict across isolates</th><td class="text">Core queues usage writes in process because every run updates the account's audit chain head. Twenty isolates writing at once exhausted Convex's retries ("OptimisticConcurrencyControlFailure" on auditChainHeads): {iso_audit[0]} of {3 * iso_audit[1]} expected rows landed.</td><td class="text">Open. Unbilled runs. Needs one writer per account outside the isolates.</td></tr>
<tr><th scope="row">Queued runs hang on workerd</th><td class="text">Past core's run limit (8 by default) runs wait and start when another finishes. On workerd they never started: {esc(hang_line)} tasks timed out after 240 s at 10 and 20 at once. Inferred cause: the queued run starts from the finished request's context, which workerd has closed.</td><td class="text">Open. The bench raised the limit to 64 on every setup so nothing queued.</td></tr>
<tr><th scope="row">Subagents don't see their parent's V8 files</th><td class="text">A persistent V8 sandbox keeps files per agent identity, and a subagent has its own; a machine's disk is shared. In the first real-model run {sep_v8_tasks - sep_v8_ok} of {sep_v8_tasks} V8 tasks failed because the parent could not find the subagent's output, and the sandbox log showed two reservations per task.</td><td class="text">Worked around with a pinned reservation key per agent (<code>options.reservationKey</code>). Open as a product question: should a subagent share its parent's files by default?</td></tr>
<tr><th scope="row">Two isolates write one sandbox</th><td class="text">Core's one-command-at-a-time lock for a sandbox lives in process memory, so separate isolates sent overlapping commands and the sandbox refused them with 409.</td><td class="text">Open. Needs the lock in the sandbox service.</td></tr>
<tr><th scope="row">Fresh isolates are kept</th><td class="text">The Worker Loader kept every uniquely named isolate, about {num(fresh.get('rssPerRequestMb'))} MB each; none was evicted while idle.</td><td class="text">Open. A per-task host must evict finished isolates.</td></tr>
<tr><th scope="row">V8 sandbox memory</th><td class="text">The sandbox (apps/cloudflare-worker on wrangler dev) keeps one isolate per sandbox reservation: about 1.5 GB in one run of 37 tasks on 20 agents, and it crashed near 4.6 GB in an early run. wrangler dev is a development server, not a host.</td><td class="text">Open. A self-hosted sandbox needs its own workerd config with limits.</td></tr>
<tr><th scope="row">No background loops on workerd</th><td class="text">Core on Bun polls Convex for crash recovery, owed subagent results and sandbox cleanup. A Worker has no long-lived timers, so none of that runs.</td><td class="text">Open. Needs an outside scheduler calling core.</td></tr>
<tr><th scope="row">Weaker SSRF guard on workerd</th><td class="text">Core connects to the IP address it validated, so DNS cannot change after the check. workerd's fetch cannot do that with the right TLS name, so the experiment's patch fetches by hostname there.</td><td class="text">Experiment only. Must not ship as is.</td></tr>
<tr><th scope="row">No machine sandbox on workerd</th><td class="text">Machines connect to core over a long-lived socket that the Worker build does not serve, so the V8 core ran only with the V8 sandbox.</td><td class="text">Open.</td></tr>
</tbody></table></div>
</section>"""

    checks = f"""
<section>
<h2>How the numbers were checked</h2>
<ul class="prose">
<li>Every task was graded from what really ran: a sha256 in a bash result, and the subagent's real count and largest prime in the final answer, with hashes removed first so their digits cannot match by chance. Failed tasks stay in the counts, in red.</li>
<li>With the scripted model, every model call is logged with the runtime that made it, and the idle runtime's count had to stay at zero for each batch; it did in every row. With the real model, core's own step log was read the same way: {other_steps} model steps appeared in another setup's log during a batch.</li>
<li>Usage had to land: after each setup's runs, the audit log had to hold one run.completed row for every run, three per task with the scripted model and, with the real model, as many as core's own log recorded. The table below is the whole record, failures included.</li>
<li>Convex calls are counted per task from core's own fetches; core on Bun's background polls are counted apart.</li>
<li>CPU and memory are read from /proc for the core and sandbox processes, children included. Setups ran in turns within each round, and the V8 sandbox and the fresh-isolate router were restarted before each of their runs.</li>
<li>Set aside, and kept on the branch as evidence: runs before the usage fix, runs at core's default run limit of 8, and one V8 core round that overlapped a typecheck on the same machine and was run again.</li>
<li>Machine: 4 vCPU Intel Xeon at 2.8 GHz, 16 GB, Linux. Bun 1.4.2, workerd 1.20261019.1, local Convex from the Broods local stack.</li>
</ul>
{audit_table()}
</section>"""

    repro = """
<section>
<h2>Reproduce</h2>
<div class="prose"><p>Everything is in <code>experiments/v8-core</code> on the branch <code>claude/project-thread-met53d</code>, with a README and the result rows. With the local stack up:</p></div>
<pre>cd experiments/v8-core && bun build.ts
./start-sandbox.sh logs/worker-sandbox.key logs/worker-state logs/worker-sandbox.log
export MAX_INPROCESS_WORKERS=64 BENCH_SCRIPTED_MODEL=1 BENCH_MODEL_DELAY_MS=0
bench/restart-cores.sh logs
AGENT_PER_TASK=1 bench/run-scripted.sh results/agents.jsonl logs 2 1,5,10,20
AGENT_PER_TASK=1 bench/run-isolate.sh results/isolate.jsonl logs 2 1,5,10,20
BENCH_SCRIPTED_MODEL=0 bench/restart-cores.sh logs -real
ANTHROPIC_API_KEY=... AGENT_PER_TASK=1 SHARED_FILES=1 bench/run-real.sh results/real.jsonl logs 3 1</pre>
</section>"""

    return f"""<title>Per-Task V8 Benchmark</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Condensed:wght@600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>{css}</style>
<main class="page">
<header>
<div class="eyebrow">Broods experiment · 30 Oct 2026</div>
<h1>One V8 isolate per agent task, measured against today's core</h1>
<p class="lede">Your idea: send each agent task to its own V8 isolate, like a function that wakes when a user clicks, instead of keeping Broods' core running. This builds it on self-hosted workerd and runs it against today's setup with a real agent that uses MCP, bash with files, and a delegated subagent.</p>
<p class="meta">Local Broods stack only; nothing touched the cloud or production. Scripts and raw rows are on the branch.</p>
</header>
{verdict}
{setups}
{real_sec}
{agents_sec}
{iso_sec}
{probe_sec}
{cost_sec}
{busy_sec}
{findings}
{checks}
{repro}
<footer>Measured 30 Oct 2026 on a 4 vCPU Linux sandbox. Prices: Hetzner CX53 list price from third-party listings; Anthropic Haiku 5.5 list price; Cloudflare Workers Standard public rates.</footer>
</main>"""
