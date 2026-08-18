package broods.authz

mode := input.mode if input.mode == "audit"
mode := "enforce" if not input.mode == "audit"

decision := {
  "allow": false,
  "allowed": false,
  "mode": mode,
  "reason": "No allow policy rule matched",
  "matchedRuleIds": [],
} if {
  count(deny_rules) == 0
  count(allow_rules) == 0
}

decision := {
  "allow": false,
  "allowed": false,
  "mode": mode,
  "reason": sprintf("Denied by policy rule %s", [deny_rules[0].id]),
  "matchedRuleIds": [rule.id | rule := deny_rules[_]],
} if {
  count(deny_rules) > 0
}

decision := {
  "allow": true,
  "allowed": true,
  "mode": mode,
  "reason": sprintf("Allowed by policy rule %s", [allow_rules[0].id]),
  "matchedRuleIds": [rule.id | rule := allow_rules[_]],
} if {
  count(deny_rules) == 0
  count(allow_rules) > 0
}

deny_rules := [rule |
  rule := matching_rules[_]
  rule.effect == "deny"
]

allow_rules := [rule |
  rule := matching_rules[_]
  rule.effect == "allow"
]

matching_rules := [rule |
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
