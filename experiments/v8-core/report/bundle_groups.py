"""Groups bench/bundle-sizes.mjs output into the categories the diagrams page
charts. python3 report/bundle_groups.py sizes.json results/bundle-composition.json"""

import json
import re
import sys

GROUPS = [
    ("Broods’ own code", r"^(apps|packages)/"),
    ("Coding-agent harnesses", r"earendil|jiti|highlight\.js|pi-tui|harness-pi|@ai-sdk/harness"),
    ("Chat channels", r"discord|slack|teams|telegram|@linear|octokit|chat-adapter|@sapphire|vladfrangu|msal|adaptivecards|@azure"),
    ("Model provider SDKs", r"@ai-sdk/(?!harness)|ai-sdk-ollama|openai|@google/genai|@anthropic-ai|openrouter|^npm:ai$|google-auth|@ai-sdk/gateway"),
    ("Other sandbox providers", r"daytona|e2b|@vercel/sandbox|@aws-sdk|@smithy|@aws-crypto|connectrpc|bufbuild"),
    ("HTTP clients and polyfills", r"undici|axios|^npm:ws$|web-streams|iconv|combined-stream|on-finished|form-data|mime|follow-redirects|node-fetch|whatwg|tr46|asynckit|delayed-stream|safer-buffer|debug$|ms$"),
    ("NATS, MCP, validation", r"nats|modelcontextprotocol|zod|typebox|yaml|jose|opa|ajv"),
]

sizes = json.load(open(sys.argv[1]))
totals = {name: 0 for name, _ in GROUPS}
totals["Other libraries"] = 0
members = {}
for key, size in sizes["rows"]:
    group = next((name for name, pattern in GROUPS if re.search(pattern, key)), "Other libraries")
    totals[group] += size
    members.setdefault(group, []).append((key, size))
out = {
    "source": "sourcemap of dist-task/task-entry.js (core harness route only), bench/bundle-sizes.mjs",
    "totalBytes": sizes["total"],
    "categories": [
        {"name": name, "bytes": round(size), "top": [k.replace("npm:", "") for k, _ in sorted(members.get(name, []), key=lambda m: -m[1])[:4]]}
        for name, size in totals.items()
    ],
}
json.dump(out, open(sys.argv[2], "w"), indent=1)
