import { defineRule } from "@oxlint/plugins";

import { propertyName, testFramework } from "../ast.ts";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `.only` on describe, test and it, so CI always runs the whole suite.",
    },
  },
  create: (context) => ({
    MemberExpression: (node): void => {
      if (propertyName(node) !== "only") return;
      if (testFramework(context, node.object) === undefined) return;
      context.report({
        node: node.property,
        message: "Drop `.only`: CI must run the whole suite, not a subset.",
      });
    },
  }),
});
