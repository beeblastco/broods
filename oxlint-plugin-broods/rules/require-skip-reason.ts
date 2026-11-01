import { defineRule, type ESTree } from "@oxlint/plugins";

import { propertyName, testFramework } from "../ast.ts";

const SKIP_MODIFIERS = new Set(["fixme", "skip", "skipIf", "todo", "todoIf"]);
const REASON_COMMENT_PATTERN = /^\s*\*?\s*skip:\s*\S/mu;
const NOT_A_REASON = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "ObjectExpression",
]);

const isString = (node: ESTree.Node): boolean =>
  (node.type === "Literal" && typeof node.value === "string") ||
  node.type === "TemplateLiteral";

const passesReason = (node: ESTree.MemberExpression): boolean => {
  const call = node.parent;
  if (call.type !== "CallExpression" || call.callee !== node) return false;
  const [condition, reason] = call.arguments;
  if (condition === undefined || reason === undefined) return false;
  if (isString(condition) || NOT_A_REASON.has(reason.type)) return false;
  return !(reason.type === "Literal" && reason.value === "");
};

const statementOf = (node: ESTree.Node): ESTree.Node => {
  let current = node;
  while (!/(?:Statement|Declaration)$/u.test(current.type) && current.parent) {
    current = current.parent;
  }
  return current.parent?.type === "ExportNamedDeclaration"
    ? current.parent
    : current;
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require every skipped or todo test to say why, in a `// skip:` comment or the reason argument.",
    },
  },
  create: (context) => ({
    MemberExpression: (node): void => {
      const modifier = propertyName(node);
      if (modifier === undefined || !SKIP_MODIFIERS.has(modifier)) return;
      if (testFramework(context, node.object) === undefined) return;
      if (passesReason(node)) return;
      const comments = context.sourceCode.getCommentsBefore(statementOf(node));
      if (comments.some(({ value }) => REASON_COMMENT_PATTERN.test(value))) {
        return;
      }
      context.report({
        node: node.property,
        message: `Say why it is skipped: put \`// skip: <reason or issue URL>\` on the line above${modifier === "skip" || modifier === "fixme" ? ", or pass the reason after the condition" : ""}.`,
      });
    },
  }),
});
