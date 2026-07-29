/**
 * Evaluates policy decision cases against the deployed OPA.
 * The rego lives here but deploys from the infra repo, so the two drift
 * silently. Exits 0 when the deployed policy agrees, 1 when it does not.
 */

const OPA_BASE_URL = process.env.OPA_BASE_URL ?? "https://opa.beeblast.co";
const OPA_API_TOKEN = process.env.OPA_API_TOKEN;
const DECISION_PATH = "/v1/data/broods/authz/decision";

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

// Assert on matchedRuleIds, not just `allow`: with no allow rule present the
// decision is false either way, so `allow` cannot tell a deny that fired from
// one that silently did nothing — which is the failure these cases exist for.
const CASES: DecisionCase[] = [
  ...denyCases("scalar", "oncall"),
  ...denyCases("array", ["oncall"]),
  {
    name: "in, scalar value, actor holds the role",
    input: allowInput("oncall", ["oncall"]),
    matchedRuleIds: ["r1"],
    allow: true,
  },
  {
    name: "in, array value, actor holds one of them",
    input: allowInput(["oncall", "sre"], ["sre"]),
    matchedRuleIds: ["r1"],
    allow: true,
  },
  {
    name: "in, scalar value, actor lacks the role",
    input: allowInput("oncall", ["sales"]),
    matchedRuleIds: [],
    allow: false,
  },
  {
    name: "scalar attribute, array value, member",
    input: channelInput("C_OPS", ["C_OPS", "C_ENG"]),
    matchedRuleIds: ["r1"],
    allow: true,
  },
  {
    name: "scalar attribute, array value, non-member",
    input: channelInput("C_SALES", ["C_OPS", "C_ENG"]),
    matchedRuleIds: [],
    allow: false,
  },
  {
    name: "scalar attribute, scalar value, equal",
    input: channelInput("C_OPS", "C_OPS"),
    matchedRuleIds: ["r1"],
    allow: true,
  },
];

async function main(): Promise<number> {
  if (!OPA_API_TOKEN) {
    console.error("OPA_API_TOKEN is required to reach the decision endpoint.");

    return 2;
  }
  let failed = 0;
  for (const decisionCase of CASES) {
    const decision = await evaluate(decisionCase.input);
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

async function evaluate(
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

function allowInput(
  value: unknown,
  actorRoles: string[],
): Record<string, unknown> {
  return policyInput("allow", "actorRoles", "in", value, {
    actorRoles: actorRoles,
  });
}

function channelInput(
  channelId: string,
  value: unknown,
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
      input: policyInput("deny", "actorRoles", "notIn", value, {
        actorRoles: ["sales"],
      }),
      matchedRuleIds: ["r1"],
      allow: false,
    },
    {
      name: `notIn, ${label} value, actor holds the role`,
      input: policyInput("deny", "actorRoles", "notIn", value, {
        actorRoles: ["oncall"],
      }),
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

process.exit(await main());
