import { matchesGlob } from "node:path";

import { defineRule, type ESTree } from "@oxlint/plugins";

type Options = {
  names: Array<string>;
  allow: Array<{ file: string; name: string }>;
};

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

const UNTYPED = new Set(["TSAnyKeyword", "TSUnknownKeyword"]);

const keyName = (
  key: ESTree.PropertyKey,
  computed: boolean,
): string | undefined =>
  !computed && key.type === "Identifier" ? key.name : undefined;

const functionName = (node: FunctionNode): string | undefined => {
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

const isStringKeyed = (type: ESTree.TSType): boolean => {
  if (type.type === "TSTypeReference") {
    return (
      type.typeName.type === "Identifier" &&
      type.typeName.name === "Record" &&
      type.typeArguments?.params[0]?.type === "TSStringKeyword"
    );
  }
  return (
    type.type === "TSTypeLiteral" &&
    type.members.some(
      (member) =>
        member.type === "TSIndexSignature" &&
        member.parameters[0]?.typeAnnotation.typeAnnotation.type ===
          "TSStringKeyword",
    )
  );
};

const narrowsUnknownToRecord = (node: FunctionNode): boolean => {
  const predicate = node.returnType?.typeAnnotation;
  if (predicate?.type !== "TSTypePredicate" || !predicate.typeAnnotation) {
    return false;
  }
  if (!isStringKeyed(predicate.typeAnnotation.typeAnnotation)) return false;
  const { parameterName } = predicate;
  return node.params.some(
    (param) =>
      param.type === "Identifier" &&
      parameterName.type === "Identifier" &&
      param.name === parameterName.name &&
      UNTYPED.has(param.typeAnnotation?.typeAnnotation.type ?? ""),
  );
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow hand-rolled `isRecord`-style guards; find the value's real type instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
          allow: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                name: { type: "string" },
              },
              required: ["file", "name"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        names: [
          "isJsonObject",
          "isObject",
          "isObjectRecord",
          "isPlainObject",
          "isRecord",
          "isStringRecord",
          "isUnknownRecord",
        ],
        allow: [],
      },
    ],
  },
  create: (context) => {
    const options = context.options[0] as Options;
    const names = new Set(options.names);
    const check = (node: FunctionNode): void => {
      const name = functionName(node);
      const named = name !== undefined && names.has(name);
      if (!named && !narrowsUnknownToRecord(node)) return;
      const allowed = options.allow.some(
        (entry) =>
          entry.name === name &&
          matchesGlob(context.filename, `**/${entry.file}`),
      );
      if (allowed) return;
      context.report({
        node: node,
        message: named
          ? `Drop \`${name}\`: find the value's real type, or the library that ships one, instead of guarding an object by hand.`
          : "Drop this `unknown` to `Record<string, …>` guard: find the value's real type, or the library that ships one.",
      });
    };
    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    };
  },
});
