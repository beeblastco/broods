/**
 * Guards the policy engine: that the rego here is correct, that OPA is running
 * this exact rego, and that it decides the way these cases expect.
 * `--local` evaluates the repo copy, `--drift` diffs the running policy against
 * it, and the default evaluates the deployed decision endpoint.
 */

import { readFile } from "node:fs/promises";

const OPA_BASE_URL = process.env.OPA_BASE_URL ?? "https://opa.beeblast.co";
const OPA_API_TOKEN = process.env.OPA_API_TOKEN;
const POLICY_PATH = "apps/core/opa/broods_authz.rego";
const PACKAGE_NAME = "package broods.authz";
const DECISION_PATH = "/v1/data/broods/authz/decision";
const DECISION_QUERY = "data.broods.authz.decision";

interface DecisionCase {
  name: string;
  input: Record<string, unknown>;
  /** Rule ids expected to match. Empty means the rule must not fire. */
  matchedRuleIds: string[];
  allow: boolean;
}

interface Decision {
  allow?: boolean;
  matchedRuleIds?: string[];
}

interface PolicyListing {
  result?: Array<{ id?: string; raw?: string }>;
}

// Assert on matchedRuleIds, not just `allow`: with no allow rule present the
// decision is false either way, so `allow` cannot tell a deny that fired from
// one that silently did nothing — which is the failure these cases exist for.
const CASES: DecisionCase[] = [
  ...denyCases("scalar", "oncall"),
  ...denyCases("array", ["oncall"]),
  {
    name: "in, scalar value, actor holds the role",
    input: rolesInput("allow", "in", "oncall", ["oncall"]),
    matchedRuleIds: ["r1"],
    allow: true,
  },
  {
    name: "in, array value, actor holds one of them",
    input: rolesInput("allow", "in", ["oncall", "sre"], ["sre"]),
    matchedRuleIds: ["r1"],
    allow: true,
  },
  {
    name: "in, scalar value, actor lacks the role",
    input: rolesInput("allow", "in", "oncall", ["sales"]),
    matchedRuleIds: [],
    allow: false,
  },
  {
    name: "contains, array attribute, actor holds the role",
    input: rolesInput("allow", "contains", "oncall", ["oncall", "sre"]),
    matchedRuleIds: ["r1"],
    allow: true,
  },
  {
    name: "scalar attribute, array value, member",
    input: channelInput(["C_OPS", "C_ENG"], "C_OPS"),
    matchedRuleIds: ["r1"],
    allow: true,
  },
  {
    name: "scalar attribute, array value, non-member",
    input: channelInput(["C_OPS", "C_ENG"], "C_SALES"),
    matchedRuleIds: [],
    allow: false,
  },
  {
    name: "scalar attribute, scalar value, equal",
    input: channelInput("C_OPS", "C_OPS"),
    matchedRuleIds: ["r1"],
    allow: true,
  },
  {
    name: "no rule matches the action",
    input: {
      action: "tool.call",
      actorRoles: ["oncall"],
      policies: [
        {
          rules: [
            {
              id: "r1",
              effect: "deny",
              actions: ["agent.invoke"],
              conditions: [],
            },
          ],
        },
      ],
    },
    matchedRuleIds: [],
    allow: false,
  },
];

async function main(): Promise<number> {
  const mode = process.argv.includes("--local")
    ? "local"
    : process.argv.includes("--drift")
      ? "drift"
      : "deployed";
  if (mode !== "local" && !OPA_API_TOKEN) {
    console.error("OPA_API_TOKEN is required to reach the deployed OPA.");

    return 2;
  }
  if (mode === "drift") return await reportDrift();

  console.log(`Evaluating ${CASES.length} cases against the ${mode} policy.\n`);
  let failed = 0;
  for (const decisionCase of CASES) {
    const decision =
      mode === "local"
        ? await evaluateLocal(decisionCase.input)
        : await evaluateDeployed(decisionCase.input);
    if (!decision) {
      console.error(`ERROR ${decisionCase.name}: no decision returned`);
      failed += 1;
      continue;
    }
    const matched = (decision.matchedRuleIds ?? []).join(",");
    const want = decisionCase.matchedRuleIds.join(",");
    if (matched === want && decision.allow === decisionCase.allow) {
      console.log(`PASS  ${decisionCase.name}`);
      continue;
    }
    console.error(
      `FAIL  ${decisionCase.name}: allow=${decision.allow} matched=[${matched}] ` +
        `want allow=${decisionCase.allow} matched=[${want}]`,
    );
    failed += 1;
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} passed`);

  return failed > 0 ? 1 : 0;
}

/** The running policy, not the configmap: a correct file may not be applied. */
async function reportDrift(): Promise<number> {
  const response = await fetch(`${OPA_BASE_URL}/v1/policies`, {
    headers: { Authorization: `Bearer ${OPA_API_TOKEN}` },
  });
  if (!response.ok) {
    console.error(`OPA answered ${response.status} listing policies.`);

    return 2;
  }
  const listing = (await response.json()) as PolicyListing;
  const deployed = (listing.result ?? []).find((policy) =>
    policy.raw?.includes(PACKAGE_NAME),
  );
  if (!deployed?.raw) {
    console.error(`No deployed policy declares "${PACKAGE_NAME}".`);

    return 1;
  }
  const local = await readFile(POLICY_PATH, "utf8");
  const deployedLines = deployed.raw.trimEnd().split("\n");
  const localLines = local.trimEnd().split("\n");
  if (deployedLines.join("\n") === localLines.join("\n")) {
    console.log(`In sync: OPA is running ${POLICY_PATH} (${localLines.length} lines).`);

    return 0;
  }
  console.error(
    `DRIFT: OPA policy "${deployed.id}" differs from ${POLICY_PATH} ` +
      `(deployed ${deployedLines.length} lines, repo ${localLines.length}).`,
  );
  let shown = 0;
  for (let i = 0; i < Math.max(deployedLines.length, localLines.length); i++) {
    if (deployedLines[i] === localLines[i]) continue;
    console.error(`  line ${i + 1}\n    deployed: ${deployedLines[i] ?? "<none>"}\n    repo:     ${localLines[i] ?? "<none>"}`);
    shown += 1;
    if (shown >= 10) {
      console.error("  ...");
      break;
    }
  }
  console.error(
    `\nThe rego deploys from the infra repo. Copy ${POLICY_PATH} into ` +
      `kubernetes/charts/releases/opa.yaml under broods_authz.rego and push.`,
  );

  return 1;
}

async function evaluateDeployed(
  input: Record<string, unknown>,
): Promise<Decision | null> {
  const response = await fetch(`${OPA_BASE_URL}${DECISION_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPA_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: input }),
  });
  if (!response.ok) {
    console.error(`  OPA answered ${response.status}`);

    return null;
  }
  const body = (await response.json()) as { result?: Decision };

  return body.result ?? null;
}

async function evaluateLocal(
  input: Record<string, unknown>,
): Promise<Decision | null> {
  const proc = Bun.spawn(
    ["opa", "eval", "-d", POLICY_PATH, "-I", "-f", "json", DECISION_QUERY],
    { stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    console.error(`  opa eval failed: ${await new Response(proc.stderr).text()}`);

    return null;
  }
  const parsed = JSON.parse(out) as {
    result?: Array<{ expressions?: Array<{ value?: Decision }> }>;
  };

  return parsed.result?.[0]?.expressions?.[0]?.value ?? null;
}

function channelInput(
  value: unknown,
  channelId: string,
): Record<string, unknown> {
  return policyInput("allow", "channelId", "in", value, {
    channelId: channelId,
  });
}

// A notIn deny must fire when the actor lacks the role and stay silent when
// they hold it — the shape that read the same either way before the fix.
function denyCases(label: string, value: unknown): DecisionCase[] {
  return [
    {
      name: `notIn, ${label} value, actor lacks the role`,
      input: rolesInput("deny", "notIn", value, ["sales"]),
      matchedRuleIds: ["r1"],
      allow: false,
    },
    {
      name: `notIn, ${label} value, actor holds the role`,
      input: rolesInput("deny", "notIn", value, ["oncall"]),
      matchedRuleIds: [],
      allow: false,
    },
  ];
}

function policyInput(
  effect: string,
  attribute: string,
  operator: string,
  value: unknown,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action: "agent.invoke",
    ...attributes,
    policies: [
      {
        rules: [
          {
            id: "r1",
            effect: effect,
            actions: ["agent.invoke"],
            conditions: [
              { attribute: attribute, operator: operator, value: value },
            ],
          },
        ],
      },
    ],
  };
}

function rolesInput(
  effect: string,
  operator: string,
  value: unknown,
  actorRoles: string[],
): Record<string, unknown> {
  return policyInput(effect, "actorRoles", operator, value, {
    actorRoles: actorRoles,
  });
}

process.exit(await main());
