import {
  defineRule,
  type ESTree,
  type Scope,
  type Variable,
} from "@oxlint/plugins";

import {
  functionName,
  isIterationCallback,
  LOOPS,
  propertyName,
} from "../ast.ts";

// Components, hooks and request or event handlers.
const REPEATED_NAME_PATTERN =
  /^(?:use[A-Z]|handle(?:[A-Z]|$)|on[A-Z])|^[A-Z](?=\w*[a-z])/u;
const ZOD_MODULE_PATTERN = /^zod(?:\/(?:mini|v3|v4|v4-mini))?$/u;
const NOT_SCHEMA = new Set([
  "config",
  "core",
  "decode",
  "decodeAsync",
  "encode",
  "encodeAsync",
  "flattenError",
  "formatError",
  "getErrorMap",
  "globalRegistry",
  "isNullable",
  "isOptional",
  "locales",
  "parse",
  "parseAsync",
  "prettifyError",
  "regexes",
  "registry",
  "safeDecode",
  "safeDecodeAsync",
  "safeEncode",
  "safeEncodeAsync",
  "safeParse",
  "safeParseAsync",
  "setErrorMap",
  "spa",
  "toJSONSchema",
  "treeifyError",
  "util",
  "validate",
  "validateAsync",
]);

const within = (outer: ESTree.Span, inner: ESTree.Span): boolean =>
  inner.start >= outer.start && inner.end <= outer.end;

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow building a static zod schema in code that runs repeatedly (a component, hook, loop, iteration callback or handler); hoist it to module scope.",
    },
  },
  create: (context) => {
    const namespaces = new Set<string>();
    const named = new Map<string, string>();
    for (const statement of context.sourceCode.ast.body) {
      if (statement.type !== "ImportDeclaration") continue;
      if (!ZOD_MODULE_PATTERN.test(statement.source.value)) continue;
      for (const specifier of statement.specifiers) {
        const imported =
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : "z";
        if (imported === "z") namespaces.add(specifier.local.name);
        else named.set(specifier.local.name, imported);
      }
    }
    if (namespaces.size === 0 && named.size === 0) return {};

    const isNamespace = (node: ESTree.Node): boolean =>
      node.type === "Identifier"
        ? namespaces.has(node.name)
        : node.type === "MemberExpression" &&
          !node.computed &&
          isNamespace(node.object);

    const zodFunction = (node: ESTree.CallExpression): string | undefined => {
      const { callee } = node;
      if (callee.type === "Identifier") return named.get(callee.name);
      return callee.type === "MemberExpression" && isNamespace(callee.object)
        ? propertyName(callee)
        : undefined;
    };

    const isSchema = (node: ESTree.Node): boolean => {
      if (node.type !== "CallExpression") return false;
      const name = zodFunction(node);
      if (name !== undefined) return !NOT_SCHEMA.has(name);
      const { callee } = node;
      if (callee.type !== "MemberExpression") return false;
      const method = propertyName(callee);
      return (
        method !== undefined &&
        !NOT_SCHEMA.has(method) &&
        isSchema(callee.object)
      );
    };

    const repeats = (node: ESTree.Node): boolean => {
      if (
        node.type !== "ArrowFunctionExpression" &&
        node.type !== "FunctionDeclaration" &&
        node.type !== "FunctionExpression"
      ) {
        return LOOPS.has(node.type);
      }
      const { parent } = node;
      const schemaCallback =
        parent.type === "CallExpression" &&
        parent.callee !== node &&
        isSchema(parent) &&
        zodFunction(parent) !== "lazy";

      return (
        schemaCallback ||
        isIterationCallback(node) ||
        REPEATED_NAME_PATTERN.test(functionName(node) ?? "") ||
        node.params.some(
          (param) =>
            param.type === "Identifier" &&
            param.typeAnnotation?.typeAnnotation.type === "TSTypeReference" &&
            param.typeAnnotation.typeAnnotation.typeName.type ===
              "Identifier" &&
            param.typeAnnotation.typeAnnotation.typeName.name === "Request",
        )
      );
    };

    const runsRepeatedly = (node: ESTree.Node): boolean => {
      for (let current = node.parent; current; current = current.parent) {
        if (isSchema(current)) return false;
        if (repeats(current)) return true;
      }
      return false;
    };

    const buildsFromLocals = (node: ESTree.CallExpression): boolean => {
      const isLocal = (variable: Variable | null): boolean =>
        variable !== null &&
        variable.scope.type !== "module" &&
        variable.scope.type !== "global" &&
        !within(node, variable.scope.block);
      const visit = (scope: Scope): boolean =>
        scope.references.some(
          (reference) =>
            within(node, reference.identifier) && isLocal(reference.resolved),
        ) ||
        scope.childScopes.some(
          (child) => within(node, child.block) && visit(child),
        );
      const { sourceCode } = context;
      return (
        visit(sourceCode.getScope(node)) ||
        sourceCode
          .getTokens(node)
          .some((token) => token.type === "Keyword" && token.value === "this")
      );
    };

    return {
      CallExpression: (node): void => {
        if (!isSchema(node) || !runsRepeatedly(node)) return;
        if (buildsFromLocals(node)) return;
        context.report({
          node: node,
          message:
            "Hoist this zod schema to a module-level const: built here, it is rebuilt on every render, iteration, parse or request.",
        });
      },
    };
  },
});
