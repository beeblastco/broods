package broods.authz

# How hard one policy bites. Mode rides on the policy document, so a set of
# policies attached to the same place can mix: a new rule can watch while an
# established one refuses.
policy_mode(policy) := "enforce" if object.get(policy, "mode", "audit") == "enforce"

policy_mode(policy) := "audit" if object.get(policy, "mode", "audit") != "enforce"

# A place is guarded once any policy attached to it enforces. Until then nothing
# here refuses, which is what keeps default-deny off while every policy is still
# being trialled.
enforcing if policy_mode(input.policies[_]) == "enforce"

mode := "enforce" if enforcing

mode := "audit" if not enforcing

decision := {
  "allow": false,
  "allowed": false,
  "mode": mode,
  "reason": sprintf("Denied by policy rule %s", [blocking_rules[0].id]),
  "matchedRuleIds": [rule.id | rule := blocking_rules[_]],
  "auditedRuleIds": [rule.id | rule := audited_rules[_]],
} if {
  count(blocking_rules) > 0
}

decision := {
  "allow": false,
  "allowed": false,
  "mode": mode,
  "reason": "No allow policy rule matched",
  "matchedRuleIds": [],
  "auditedRuleIds": [],
} if {
  count(blocking_rules) == 0
  count(deny_rules) == 0
  count(allow_rules) == 0
  enforcing
}

# A deny from a policy still in audit is reported and then let through, so the
# rollout can be watched on live traffic without refusing anyone.
decision := {
  "allow": true,
  "allowed": true,
  "mode": mode,
  "reason": sprintf("Audited by policy rule %s: would deny, policy is not enforcing", [audited_rules[0].id]),
  "matchedRuleIds": [rule.id | rule := allow_rules[_]],
  "auditedRuleIds": [rule.id | rule := audited_rules[_]],
} if {
  count(blocking_rules) == 0
  count(audited_rules) > 0
}

decision := {
  "allow": true,
  "allowed": true,
  "mode": mode,
  "reason": sprintf("Allowed by policy rule %s", [allow_rules[0].id]),
  "matchedRuleIds": [rule.id | rule := allow_rules[_]],
  "auditedRuleIds": [],
} if {
  count(blocking_rules) == 0
  count(audited_rules) == 0
  count(allow_rules) > 0
}

decision := {
  "allow": true,
  "allowed": true,
  "mode": mode,
  "reason": "No policy rule matched and nothing here is enforcing",
  "matchedRuleIds": [],
  "auditedRuleIds": [],
} if {
  count(blocking_rules) == 0
  count(audited_rules) == 0
  count(allow_rules) == 0
  not enforcing
}

# Only an enforcing policy's deny actually refuses.
blocking_rules := [rule |
  rule := deny_rules[_]
  rule.mode == "enforce"
]

audited_rules := [rule |
  rule := deny_rules[_]
  rule.mode == "audit"
]

deny_rules := [rule |
  rule := matching_rules[_]
  rule.effect == "deny"
]

allow_rules := [rule |
  rule := matching_rules[_]
  rule.effect == "allow"
]

# Each matched rule carries the mode of the policy that owns it, so the verdict
# can tell an enforcing refusal from one that is only being watched.
matching_rules := [{"id": rule.id, "effect": rule.effect, "mode": policy_mode(policy)} |
  policy := input.policies[_]
  rule := policy.rules[_]
  rule_matches(rule)
]

rule_matches(rule) if {
  rule.actions[_] == object.get(input, "action", null)
  resources_match(rule)
  conditions_match(rule)
}

resources_match(rule) if object.get(rule, "resources", null) == null

resources_match(rule) if {
  resources := object.get(rule, "resources", {})
  selector_missing_or_matches(object.get(resources, "toolNames", null), object.get(input, "toolName", null), false)
  selector_missing_or_matches(object.get(resources, "toolIds", null), object.get(input, "toolId", null), false)
  selector_missing_or_matches(object.get(resources, "mcpIds", null), object.get(input, "mcpId", null), false)
  selector_missing_or_matches(object.get(resources, "workspaceIds", null), object.get(input, "workspaceId", null), false)
  selector_missing_or_matches(object.get(resources, "workspaceNames", null), object.get(input, "workspaceName", null), false)
  selector_missing_or_matches(object.get(resources, "subagentIds", null), object.get(input, "subagentId", null), false)
  selector_missing_or_matches(object.get(resources, "filePaths", null), object.get(input, "filePath", null), true)
  selector_missing_or_matches(object.get(resources, "skillPaths", null), object.get(input, "skillPath", null), true)
}

selector_missing_or_matches(values, _, _) if values == null

selector_missing_or_matches(values, value, false) if {
  value != null
  values[_] == value
}

selector_missing_or_matches(values, value, true) if {
  value != null
  prefix := values[_]
  startswith(value, prefix)
}

conditions_match(rule) if {
  conditions := object.get(rule, "conditions", [])
  every condition in conditions {
    condition_match(condition)
  }
}

condition_match(condition) if {
  actual := condition_attribute_value(condition.attribute)
  condition.operator == "equals"
  actual == condition.value
}

# Negated operators require the attribute to be present so a rule scoped by
# notEquals/notIn cannot match requests that never carried the attribute.
condition_match(condition) if {
  condition.operator == "notEquals"
  actual := condition_attribute_value(condition.attribute)
  actual != null
  actual != condition.value
}

# `in`/`notIn` compare against a set. A scalar is read as the one-element set:
# otherwise it satisfies no branch at all, and a notIn deny silently never fires.
condition_values(condition) := condition.value if is_array(condition.value)

condition_values(condition) := [condition.value] if not is_array(condition.value)

condition_match(condition) if {
  condition.operator == "in"
  actual := condition_attribute_value(condition.attribute)
  not is_array(actual)
  value_in_collection(condition_values(condition), actual)
}

# Array-valued attributes (userRoles) match `in` on any overlap, so a rule can
# be scoped to people holding one of several roles.
condition_match(condition) if {
  condition.operator == "in"
  actual := condition_attribute_value(condition.attribute)
  is_array(actual)
  actual[_] == condition_values(condition)[_]
}

condition_match(condition) if {
  condition.operator == "notIn"
  actual := condition_attribute_value(condition.attribute)
  actual != null
  not is_array(actual)
  not value_in_collection(condition_values(condition), actual)
}

# An array attribute is "not in" the set only when nothing overlaps; without
# this a user who does hold the named role would still satisfy notIn.
condition_match(condition) if {
  condition.operator == "notIn"
  actual := condition_attribute_value(condition.attribute)
  is_array(actual)
  not arrays_overlap(condition_values(condition), actual)
}

condition_match(condition) if {
  actual := condition_attribute_value(condition.attribute)
  condition.operator == "prefix"
  is_string(actual)
  startswith(actual, condition.value)
}

condition_match(condition) if {
  actual := condition_attribute_value(condition.attribute)
  condition.operator == "contains"
  is_string(actual)
  contains(actual, condition.value)
}

# On an array attribute, `contains` means membership: "the user holds this role".
condition_match(condition) if {
  condition.operator == "contains"
  actual := condition_attribute_value(condition.attribute)
  is_array(actual)
  actual[_] == condition.value
}

value_in_collection(values, actual) if {
  values[_] == actual
}

arrays_overlap(values, actual) if {
  values[_] == actual[_]
}

condition_attribute_value(attribute) := value if {
  value := object.get(input, split(attribute, "."), null)
}
