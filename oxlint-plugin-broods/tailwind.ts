import type { Context, ESTree, Visitor } from "@oxlint/plugins";

interface ClassToken {
  readonly token: string;
  readonly utility: string;
}

export interface ArbitraryProperty {
  readonly name: string;
  readonly value: string;
}

interface StyleDeclaration {
  readonly name: string;
  readonly value: string;
  readonly node: ESTree.ObjectProperty;
}

const ARBITRARY_PROPERTY_PATTERN = /^\[(-?[a-z][a-z-]*):(.+)\]$/u;

const utilityOf = (token: string): string => {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[" || char === "(") depth++;
    else if ((char === "]" || char === ")") && depth > 0) depth--;
    else if (char === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/gu, "");
};

const classTokens = (text: string): Array<ClassToken> =>
  text
    .split(/\s+/u)
    .filter((token) => token !== "")
    .map((token) => ({ token: token, utility: utilityOf(token) }));

export const arbitraryValue = (
  utility: string,
  prefix: string,
): string | undefined =>
  utility.startsWith(`${prefix}[`) && utility.endsWith("]")
    ? utility.slice(prefix.length + 1, -1).replaceAll("_", " ")
    : undefined;

export const arbitraryProperty = (
  utility: string,
): ArbitraryProperty | undefined => {
  const [, name, value] = ARBITRARY_PROPERTY_PATTERN.exec(utility) ?? [];
  return name === undefined || value === undefined
    ? undefined
    : { name: name, value: value.replaceAll("_", " ") };
};

export const visitStrings = (
  check: (text: string, node: ESTree.Node) => void,
): Visitor => ({
  Literal: (node): void => {
    if (typeof node.value === "string") check(node.value, node);
  },
  TemplateElement: (node): void => {
    check(node.value.cooked ?? node.value.raw, node);
  },
});

const keyName = (key: ESTree.PropertyKey): string | undefined => {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
};

const staticText = (value: ESTree.Node): string | undefined => {
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type === "TemplateLiteral" && value.expressions.length === 0) {
    return value.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const styleDeclarations = (
  node: ESTree.ObjectExpression,
): Array<StyleDeclaration> =>
  node.properties.flatMap((property) => {
    if (property.type !== "Property" || property.computed) return [];
    const name = keyName(property.key);
    const value = staticText(property.value);
    return name === undefined || value === undefined
      ? []
      : [
          {
            name: name.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`),
            value: value,
            node: property,
          },
        ];
  });

export interface ClassAndStyleCheck {
  readonly matchesClass: (utility: string) => boolean;
  readonly matchesDeclaration: (name: string, value: string) => boolean;
  readonly message: (what: string) => string;
}

export const visitClassesAndStyles = (
  context: Context,
  check: ClassAndStyleCheck,
): Visitor => ({
  ...visitStrings((text, node) => {
    for (const { token, utility } of classTokens(text)) {
      if (check.matchesClass(utility)) {
        context.report({ node: node, message: check.message(token) });
      }
    }
  }),
  ObjectExpression: (node): void => {
    for (const { name, value, node: property } of styleDeclarations(node)) {
      if (check.matchesDeclaration(name, value)) {
        context.report({
          node: property,
          message: check.message(`${name}: ${value}`),
        });
      }
    }
  },
});
