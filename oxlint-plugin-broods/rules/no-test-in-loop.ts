import { defineRule, type ESTree } from "@oxlint/plugins";

import { propertyName, testFramework, testRoot } from "../ast.ts";

const EACH_FRAMEWORKS = new Set(["", "bun:test", "vitest"]);
const LOOPS = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);
const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const ITERATING_METHODS = new Set(["flatMap", "forEach", "map"]);

const usesEach = (node: ESTree.Node): boolean => {
  if (node.type === "CallExpression") return usesEach(node.callee);
  if (node.type !== "MemberExpression") return false;
  return propertyName(node) === "each" || usesEach(node.object);
};

const isIterationCallback = (node: ESTree.Node): boolean => {
  const call = node.parent;
  return (
    call?.type === "CallExpression" &&
    call.callee !== node &&
    call.callee.type === "MemberExpression" &&
    ITERATING_METHODS.has(propertyName(call.callee) ?? "")
  );
};

const isInsideLoop = (node: ESTree.Node): boolean => {
  for (let current = node.parent; current; current = current.parent) {
    if (LOOPS.has(current.type)) return true;
    if (FUNCTIONS.has(current.type)) return isIterationCallback(current);
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
      const root = testRoot(node.callee);
      if (root === undefined || usesEach(node.callee)) return;
      const { parent } = node;
      if (parent.type === "MemberExpression") return;
      if (parent.type === "CallExpression" && parent.callee === node) return;
      const framework = testFramework(context, node.callee);
      if (framework === undefined || !EACH_FRAMEWORKS.has(framework)) return;
      if (!isInsideLoop(node)) return;
      context.report({
        node: node.callee,
        message: `Use ${root}.each(cases)(name, fn) instead of declaring ${root}() in a loop.`,
      });
    },
  }),
});
