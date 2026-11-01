import { defineRule, type ESTree } from "@oxlint/plugins";

const HOOK_NAME_PATTERN = /^use[A-Z]/u;
const HOOK_CALLEE_PATTERN = /^use(?:[A-Z]|$)/u;

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

interface Frame {
  readonly fn: FunctionNode;
  callsHook: boolean;
}

const isHookCallee = (callee: ESTree.Node): boolean => {
  if (callee.type === "Identifier")
    return HOOK_CALLEE_PATTERN.test(callee.name);
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    HOOK_CALLEE_PATTERN.test(callee.property.name)
  );
};

const hookName = (fn: FunctionNode): ESTree.Node | undefined => {
  if (fn.type === "FunctionDeclaration") return fn.id ?? undefined;
  const { parent } = fn;
  return parent.type === "VariableDeclarator" &&
    parent.init === fn &&
    parent.id.type === "Identifier"
    ? parent.id
    : undefined;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow use* functions that call no hook; the prefix binds every caller to the rules of hooks for nothing.",
    },
  },
  create: (context) => {
    const frames: Array<Frame> = [];
    const enter = (fn: FunctionNode): void => {
      frames.push({ fn: fn, callsHook: false });
    };
    const exit = (): void => {
      const frame = frames.pop();
      if (frame === undefined || frame.callsHook) return;
      const id = hookName(frame.fn);
      if (id?.type !== "Identifier" || !HOOK_NAME_PATTERN.test(id.name)) return;
      context.report({
        node: id,
        message: `Rename \`${id.name}\` to a plain function, or call the hook it depends on inside it: it calls no hook, so the use prefix only binds its callers to the rules of hooks.`,
      });
    };
    return {
      FunctionDeclaration: enter,
      FunctionExpression: enter,
      ArrowFunctionExpression: enter,
      "FunctionDeclaration:exit": exit,
      "FunctionExpression:exit": exit,
      "ArrowFunctionExpression:exit": exit,
      CallExpression: (node): void => {
        const frame = frames.at(-1);
        if (frame !== undefined && isHookCallee(node.callee)) {
          frame.callsHook = true;
        }
      },
    };
  },
});
