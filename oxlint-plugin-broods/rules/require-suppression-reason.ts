import { defineRule } from "@oxlint/plugins";

const TS_DIRECTIVE_PATTERN =
  /^\s*\*?\s*@ts-(expect-error|ignore|nocheck)(?![\w-])(.*)$/su;

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require every lint or type-checker suppression to say why it is safe.",
    },
  },
  create: (context) => {
    const { sourceCode } = context;
    return {
      Program: (): void => {
        for (const directive of sourceCode.getDisableDirectives().directives) {
          if (directive.type === "enable" || directive.justification.trim()) {
            continue;
          }
          context.report({
            loc: directive.node.loc,
            message: "Say why: end the directive with `-- <reason>`.",
          });
        }

        for (const comment of sourceCode.getAllComments()) {
          const match = TS_DIRECTIVE_PATTERN.exec(comment.value);
          if (match === null) continue;
          const [, kind, after = ""] = match;
          if (kind === "expect-error") {
            if (after.replace(/^[\s:-]+/u, "").trim()) continue;
            context.report({
              loc: comment.loc,
              message:
                "Say why: write the reason after `@ts-expect-error` on the same line.",
            });
            continue;
          }
          context.report({
            loc: comment.loc,
            message: `Drop \`@ts-${kind}\`: fix the type, or put \`@ts-expect-error <reason>\` on the one line that needs it.`,
          });
        }
      },
    };
  },
});
