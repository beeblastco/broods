import { defineRule, type ESTree } from "@oxlint/plugins";

const EFFECT_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);
const EFFECT_HOOK_TEXT = /use(?:Layout|Insertion)?Effect/u;
const TEST_FILE_PATTERN =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|[\\/](?:tests?|__tests__|e2e)[\\/]/u;
const MESSAGE =
  "Derive the value in render, act in the event handler, key the component to reset its state, or read outside state with useSyncExternalStore; an effect that keeps something outside React in step (a DOM node, listener, timer, socket) stays with `// oxlint-disable-next-line broods/no-unreasoned-state-sync -- <what outside React it syncs with>`.";

const isEffectHook = (callee: ESTree.Node): boolean => {
  if (callee.type === "Identifier") return EFFECT_HOOKS.has(callee.name);
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    EFFECT_HOOKS.has(callee.property.name)
  );
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Report every React effect hook outside tests; one that stays names what outside React it syncs with.",
    },
  },
  create: (context) => {
    if (
      TEST_FILE_PATTERN.test(context.filename) ||
      !EFFECT_HOOK_TEXT.test(context.sourceCode.text)
    ) {
      return {};
    }
    return {
      CallExpression: (node): void => {
        if (isEffectHook(node.callee)) {
          context.report({ node: node, message: MESSAGE });
        }
      },
    };
  },
});
