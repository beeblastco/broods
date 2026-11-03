import type { Context, ESTree, Scope } from "@oxlint/plugins";

const TEST_FUNCTIONS = new Set(["describe", "it", "suite", "test"]);

export const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

export const LOOPS = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);

const ITERATING_METHODS = new Set([
  "filter",
  "flatMap",
  "forEach",
  "map",
  "reduce",
]);

export type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

const chainRoot = (node: ESTree.Node): ESTree.Node => {
  if (node.type === "MemberExpression") return chainRoot(node.object);
  if (node.type === "CallExpression") return chainRoot(node.callee);
  return node;
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

const keyName = (
  key: ESTree.PropertyKey,
  computed: boolean,
): string | undefined =>
  !computed && key.type === "Identifier" ? key.name : undefined;

// The name a function is declared or assigned under.
export const functionName = (node: FunctionNode): string | undefined => {
  if (node.id) return node.id.name;
  const { parent } = node;
  if (parent.type === "VariableDeclarator") {
    return parent.init === node && parent.id.type === "Identifier"
      ? parent.id.name
      : undefined;
  }
  if (
    parent.type === "Property" ||
    parent.type === "MethodDefinition" ||
    parent.type === "PropertyDefinition"
  ) {
    return parent.value === node
      ? keyName(parent.key, parent.computed)
      : undefined;
  }
  return undefined;
};

// A callback an array method runs once per element.
export const isIterationCallback = (node: ESTree.Node): boolean => {
  const call = node.parent;
  return (
    call?.type === "CallExpression" &&
    call.callee !== node &&
    call.callee.type === "MemberExpression" &&
    ITERATING_METHODS.has(propertyName(call.callee) ?? "")
  );
};

// The name a call goes by: `name(...)` or `object.name(...)`.
export const calleeName = (callee: ESTree.Node): string | undefined => {
  if (callee.type === "Identifier") return callee.name;
  return callee.type === "MemberExpression" ? propertyName(callee) : undefined;
};

// The test function a call chain starts from, followed through its import: `test`,
// `{ test as check }` and `tests.test` all resolve, with their module ("" for a global).
export const testFunction = (
  context: Context,
  node: ESTree.Node,
): { name: string; source: string } | undefined => {
  const root = chainRoot(node);
  if (root.type !== "Identifier") return undefined;
  let scope: Scope | null = context.sourceCode.getScope(root);
  for (; scope !== null; scope = scope.upper) {
    const definition = scope.set.get(root.name)?.defs[0];
    if (definition === undefined) continue;
    if (
      definition.type !== "ImportBinding" ||
      definition.parent?.type !== "ImportDeclaration"
    ) {
      return undefined;
    }
    const source = definition.parent.source.value;
    const specifier = definition.node;
    const name =
      specifier.type === "ImportSpecifier"
        ? specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : String(specifier.imported.value)
        : specifier.type === "ImportNamespaceSpecifier" &&
            root.parent?.type === "MemberExpression" &&
            root.parent.object === root
          ? propertyName(root.parent)
          : undefined;

    return name !== undefined && TEST_FUNCTIONS.has(name)
      ? { name: name, source: source }
      : undefined;
  }

  return TEST_FUNCTIONS.has(root.name)
    ? { name: root.name, source: "" }
    : undefined;
};
