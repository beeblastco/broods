import type { Context, ESTree, Scope } from "@oxlint/plugins";

const TEST_FUNCTIONS = new Set(["describe", "it", "suite", "test"]);

const chainRoot = (node: ESTree.Node): ESTree.Node => {
  if (node.type === "MemberExpression") return chainRoot(node.object);
  if (node.type === "CallExpression") return chainRoot(node.callee);
  return node;
};

export const testRoot = (node: ESTree.Node): string | undefined => {
  const root = chainRoot(node);
  return root.type === "Identifier" && TEST_FUNCTIONS.has(root.name)
    ? root.name
    : undefined;
};

export const propertyName = (
  node: ESTree.MemberExpression,
): string | undefined => {
  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : undefined;
  }
  return node.property.type === "Literal" &&
    typeof node.property.value === "string"
    ? node.property.value
    : undefined;
};

export const testFramework = (
  context: Context,
  node: ESTree.Node,
): string | undefined => {
  const root = chainRoot(node);
  if (root.type !== "Identifier" || !TEST_FUNCTIONS.has(root.name)) {
    return undefined;
  }
  let scope: Scope | null = context.sourceCode.getScope(root);
  for (; scope !== null; scope = scope.upper) {
    const definition = scope.set.get(root.name)?.defs[0];
    if (definition === undefined) continue;
    return definition.type === "ImportBinding" &&
      definition.parent?.type === "ImportDeclaration"
      ? definition.parent.source.value
      : undefined;
  }
  return "";
};
