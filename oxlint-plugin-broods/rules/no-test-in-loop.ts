import { defineRule, type ESTree } from "@oxlint/plugins";

import {
  FUNCTION_TYPES,
  isIterationCallback,
  LOOPS,
  propertyName,
  testFunction,
} from "../ast.ts";

const EACH_FRAMEWORKS = new Set(["", "bun:test", "vitest"]);

const usesEach = (node: ESTree.Node): boolean => {
  if (node.type === "CallExpression") return usesEach(node.callee);
  if (node.type !== "MemberExpression") return false;
  return propertyName(node) === "each" || usesEach(node.object);
};

const isInsideLoop = (node: ESTree.Node): boolean => {
  for (let current = node.parent; current; current = current.parent) {
    if (LOOPS.has(current.type)) return true;
    if (FUNCTION_TYPES.has(current.type)) return isIterationCallback(current);
  }
  return false;
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow declaring tests inside a loop; use test.each / describe.each instead.",
    },
  },
  create: (context) => ({
    CallExpression: (node): void => {
      const test = testFunction(context, node.callee);
      if (test === undefined || usesEach(node.callee)) return;
      const { parent } = node;
      if (parent.type === "MemberExpression") return;
      if (parent.type === "CallExpression" && parent.callee === node) return;
      if (!EACH_FRAMEWORKS.has(test.source)) return;
      if (!isInsideLoop(node)) return;
      context.report({
        node: node.callee,
        message: `Use ${test.name}.each(cases)(name, fn) instead of declaring ${test.name}() in a loop.`,
      });
    },
  }),
});
