import { defineRule, type ESTree } from "@oxlint/plugins";

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);

type Options = { allowIn: Array<string> };

const globPattern = (glob: string): RegExp =>
  new RegExp(
    `(?:^|/)${glob
      .split(/(\*\*\/|\*\*|\*|\?)/u)
      .map((part) => {
        if (part === "**/") return "(?:.*/)?";
        if (part === "**") return ".*";
        if (part === "*") return "[^/]*";
        if (part === "?") return "[^/]";
        return part.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
      })
      .join("")}$`,
    "u",
  );

const isResizeObserver = (node: ESTree.Node): boolean => {
  if (node.type === "Identifier") return node.name === "ResizeObserver";
  if (node.type !== "MemberExpression" || node.object.type !== "Identifier") {
    return false;
  }
  if (!GLOBAL_OBJECTS.has(node.object.name)) return false;
  const { property } = node;
  if (!node.computed) {
    return property.type === "Identifier" && property.name === "ResizeObserver";
  }
  return property.type === "Literal" && property.value === "ResizeObserver";
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow constructing ResizeObserver outside the one module that wraps it.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowIn: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowIn: ["app/lib/observeResize.ts"] }],
  },
  create: (context) => {
    const { allowIn } = context.options[0] as Options;
    const filename = context.filename.replaceAll("\\", "/");
    if (allowIn.some((glob) => globPattern(glob).test(filename))) return {};
    return {
      NewExpression: (node): void => {
        if (!isResizeObserver(node.callee)) return;
        context.report({
          node: node.callee,
          message:
            "Use observeResize from `@/app/lib/observeResize`: state set in a raw ResizeObserver callback commits after the paint, so layout read from the size lands a frame late.",
        });
      },
    };
  },
});
