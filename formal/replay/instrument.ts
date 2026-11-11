import {
  analyzeFile,
  type AstNode,
  type FunctionInfo,
} from "../scripts/functions.ts";

type EditKind = "close" | "open" | "replace";
// Whose code a node is: the function's own, a closure of it that may run as its own trace (L25),
// or code whose awaits suspend only some inner function.
type Scope = "own" | "late" | "none";

interface Edit {
  start: number;
  end: number;
  text: string;
  kind: EditKind;
}

const CALL = "globalThis.__specCall";
const METHOD = "globalThis.__specMethod";
const HIT = "globalThis.__specHit";
const NEW = "globalThis.__specNew";
const ENTER = "globalThis.__specEnter";
const LATE = "globalThis.__specLate";
const RESUME = "globalThis.__specResume";
const RANK: Record<EditKind, number> = { close: 0, open: 1, replace: 2 };
// A call hanging off one of these cannot be routed without changing what short-circuits, so it is
// left alone. These names are JavaScript built-ins, whose results a twin works out itself.
const PURE_METHODS = new Set(
  "trim trimStart trimEnd toLowerCase toUpperCase toString slice substring split join map filter find findIndex some every includes indexOf lastIndexOf startsWith endsWith replace replaceAll flatMap flat reduce concat at keys values entries padStart padEnd localeCompare toFixed match matchAll sort reverse".split(
    " ",
  ),
);

const INLINE_METHODS = new Set(["forEach", "then", "catch", "finally"]);
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "any", "race"]);
const SETTLE_CHAIN = new Set(["then", "catch", "finally"]);
// Below these the code belongs to another function; the rest only wrap an expression.
const SCOPES = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "ClassExpression",
]);
const TRANSPARENT = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

// Returns `source` with each listed function wrapped, each statement and branch arm in it probed,
// and each call in it routed through the tracer. Nothing else about the file changes.
export function instrument(
  file: string,
  source: string,
  wanted: Set<string>,
): string {
  const analysis = analyzeFile(file, source);
  const targets = analysis.functions.filter(
    (entry) => (entry.wrappable || entry.isPrivate) && wanted.has(entry.source),
  );
  const edits: Edit[] = [];
  const wraps: string[] = [];
  const rebound = new Set<number>();
  const mutable = moduleMutable(analysis.program);
  for (const target of targets) {
    const id = JSON.stringify(target.source);
    if (target.isPrivate) {
      const node = functionNode(analysis.program, target);
      if (node && node["generator"] !== true)
        edits.push(...entryEdits(target, node, mutable));
      continue;
    }
    if (target.kind === "method") {
      const [owner = "", method = ""] = target.name.split(".");
      wraps.push(
        `if (typeof ${owner}.prototype.${method} === "function") ` +
          `${owner}.prototype.${method} = globalThis.__specWrap(${id}, ${owner}.prototype.${method});`,
      );
    } else {
      if (target.kind === "const") {
        const keyword = source.slice(0, target.start).lastIndexOf("const ");
        if (keyword === -1) continue;
        if (!rebound.has(keyword)) {
          edits.push({
            start: keyword,
            end: keyword + 5,
            text: "let",
            kind: "replace",
          });
          rebound.add(keyword);
        }
      }
      wraps.push(
        `${target.name} = globalThis.__specWrap(${id}, ${target.name});`,
      );
    }
    const node = functionNode(analysis.program, target);
    if (node && node["generator"] !== true)
      edits.push(...entryEdits(target, node, mutable));
  }
  const live = new Set(
    targets
      .filter((target) => {
        const node = functionNode(analysis.program, target);

        return node !== undefined && node["generator"] !== true;
      })
      .map((target) => target.source),
  );
  // Parameter defaults run before the hook that binds the frame, so nothing there is touched.
  const bodies = new Map(
    targets.flatMap((target) => {
      const body = functionNode(analysis.program, target)?.["body"] as
        | AstNode
        | undefined;

      return body ? [[target.source, body] as const] : [];
    }),
  );
  const inBody = (owner: string, offset: number): boolean => {
    const body = bodies.get(owner);

    return body !== undefined && body.start <= offset && offset < body.end;
  };
  const ownBodies = new Set(
    targets
      .map((target) => functionNode(analysis.program, target))
      .map((node) => node?.["body"] as AstNode | undefined),
  );
  for (const site of analysis.statements) {
    if (!site.owner || !live.has(site.owner)) continue;
    if (!inBody(site.owner, site.node.start)) continue;
    const start = site.node.start;
    const probe = `${HIT}(__specF,${start})`;
    if (site.slot === "list") {
      edits.push(open(start, `${probe};`));
    } else if (site.slot === "single") {
      edits.push(open(start, `{${probe};`), close(site.node.end, "}"));
    } else if (ownBodies.has(site.node)) {
      edits.push(open(start, `${probe},`));
    } else {
      edits.push(open(start, `(${probe},`), close(site.node.end, ")"));
    }
  }
  for (const arm of analysis.arms) {
    if (!arm.owner || !live.has(arm.owner) || arm.implicit) continue;
    if (!inBody(arm.owner, arm.node.start)) continue;
    const start = arm.node.start;
    const probe = `${HIT}(__specF,${start})`;
    if (arm.kind === "ternary" || arm.kind === "logical") {
      edits.push(open(start, `(${probe},`), close(arm.node.end, ")"));
    } else if (arm.kind === "case") {
      const colon = caseColon(arm.node, source);
      if (colon !== -1) edits.push(open(colon + 1, `${probe};`));
    } else if (arm.node.type === "BlockStatement") {
      edits.push(open(start + 1, `${probe};`));
    } else if (arm.node.type !== "IfStatement" || arm.kind === "if-true") {
      // A statement in a single slot was given braces above, so a probe fits in front of it.
      edits.push(open(start, `${probe};`));
    } else {
      edits.push(open(start, `{${probe};`), close(arm.node.end, "}"));
    }
  }
  for (const target of targets) {
    if (!live.has(target.source)) continue;
    const body = bodies.get(target.source);
    if (!body) continue;
    const escaped = escapedClosures(body);
    edits.push(...escapeEdits(escaped));
    edits.push(...lateEdits(target, analysis.program, body, escaped, mutable));
    edits.push(
      ...callEdits(
        body,
        source,
        withCallbackHelpers(body, escaped),
        inlinedCallbacks(target, analysis.program),
      ),
    );
  }

  edits.push(...privateFieldReaders(analysis.program));

  return `${applyEdits(source, edits)}\n;${wraps.join("\n")}\n`;
}

// A static block can read `#private` fields and adds no visible member, so a class's private state
// reaches the recorder without changing the class.
function privateFieldReaders(program: AstNode): Edit[] {
  const edits: Edit[] = [];
  walk(program, (node) => {
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression")
      return;
    const body = node["body"] as { body: AstNode[]; end: number };
    const names = body.body
      .filter(
        (member) =>
          member.type === "PropertyDefinition" &&
          member["static"] !== true &&
          (member["key"] as AstNode).type === "PrivateIdentifier",
      )
      .map((member) => String((member["key"] as AstNode)["name"]));
    if (names.length === 0) return;
    const fields = names
      .map((name) => `${JSON.stringify(`#${name}`)}:o.#${name}`)
      .join(",");
    edits.push(
      close(
        body.end - 1,
        `static{globalThis.__specPrivate?.(this,(o)=>#${names[0]} in o?{${fields}}:{});}`,
      ),
    );
  });

  return edits;
}

function open(at: number, text: string): Edit {
  return { start: at, end: at, text: text, kind: "open" };
}

function close(at: number, text: string): Edit {
  return { start: at, end: at, text: text, kind: "close" };
}

function caseColon(node: AstNode, source: string): number {
  const test = node["test"] as AstNode | null;

  return source.indexOf(":", test ? test.end : node.start);
}

function entryEdits(
  target: FunctionInfo,
  node: AstNode,
  mutable: Set<string>,
): Edit[] {
  const body = node["body"] as AstNode | null;
  if (!body) return [];
  const inputs = inputCapture(node, body, mutable);
  // A private method cannot be wrapped or called from a recording: it runs in its caller's frame.
  const hook = target.isPrivate
    ? "const __specF=globalThis.__specInherit();"
    : `const __specF=globalThis.__specFrame(${JSON.stringify(target.source)});`;
  if (body.type === "BlockStatement")
    return [open(body.start + 1, `${hook}${inputs}`)];

  return [
    open(body.start, `{${hook}${inputs}return (`),
    close(body.end, ");}"),
  ];
}

// What a function can read beyond its arguments, so a twin can be given it: parameters after their
// defaults ran, and any module-level mutable binding it mentions. Read as thunks, since a binding
// may not be initialised yet when the module is still loading.
function inputCapture(
  node: AstNode,
  body: AstNode,
  mutable: Set<string>,
): string {
  const params = node["params"] as AstNode[];
  const parts: string[] = [];
  if (params.some((param) => param.type === "AssignmentPattern")) {
    parts.push(
      `globalThis.__specParams(__specF,[${parameterNames(params).join(",")}]);`,
    );
  }
  const used = [...mentioned(body)].filter((name) => mutable.has(name)).sort();
  if (used.length > 0) {
    const thunks = used.map((name) => `${name}:()=>${name}`).join(",");
    parts.push(`globalThis.__specModule(__specF,{${thunks}});`);
  }

  return parts.join("");
}

function mentioned(body: AstNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: AstNode): void => {
    if (node.type === "Identifier") names.add(node["name"] as string);
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "property" &&
        node.type === "MemberExpression" &&
        node["computed"] !== true
      ) {
        continue;
      }
      if (
        key === "key" &&
        node.type === "Property" &&
        node["computed"] !== true
      )
        continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) visit(item);
        }
      } else if (isNode(value)) {
        visit(value);
      }
    }
  };
  visit(body);

  return names;
}

// Top-level `let`s and `const`s holding a mutable collection: a function reading one depends on
// what earlier calls left there.
function moduleMutable(program: AstNode): Set<string> {
  const names = new Set<string>();
  for (const statement of program["body"] as AstNode[]) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? (statement["declaration"] as AstNode | null)
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration["declarations"] as AstNode[]) {
      const id = item["id"] as { name?: string };
      const init = item["init"] as AstNode | null;
      if (!id.name) continue;
      const collection =
        init?.type === "ArrayExpression" ||
        init?.type === "ObjectExpression" ||
        (init?.type === "NewExpression" &&
          ["Map", "Set", "WeakMap", "WeakSet"].includes(
            String(
              ((init["callee"] as AstNode)["name"] as string | undefined) ?? "",
            ),
          ));
      if (declaration["kind"] === "let" || collection) names.add(id.name);
    }
  }

  return names;
}

export function functionNode(
  program: AstNode,
  target: FunctionInfo,
): AstNode | undefined {
  let found: AstNode | undefined;
  walk(program, (node) => {
    if (found || node.start !== target.start || node.end !== target.end) return;
    if (target.kind === "function" && node.type === "FunctionDeclaration")
      found = node;
    if (target.kind === "const" && node.type === "VariableDeclarator")
      found = node["init"] as AstNode;
    if (target.kind === "method" && node.type === "MethodDefinition")
      found = node["value"] as AstNode;
  });

  return found;
}

function callEdits(
  body: AstNode,
  source: string,
  escaped: Map<AstNode, string>,
  inlined: string[],
): Edit[] {
  const edits: Edit[] = [];
  const locals = new Set([...localFunctions(body), ...inlined]);
  const late = new Set(lateClosures(body, escaped).keys());
  // `x.closed = true` and similar cannot go through a read helper.
  const writeTargets = new Set<AstNode>();
  const visit = (
    node: AstNode,
    nested: boolean,
    detached = false,
    awaited = false,
    scope: Scope = "own",
  ): void => {
    const inside = nested || escaped.has(node);
    // Code after an `await` may run mid-statement, where no statement probe would see it.
    if (node.type === "AwaitExpression")
      edits.push(open(node.start, `${RESUME}(__specF,`), close(node.end, ")"));
    if (node.type === "AssignmentExpression")
      writeTargets.add(node["left"] as AstNode);
    if (node.type === "UpdateExpression")
      writeTargets.add(node["argument"] as AstNode);
    if (node.type === "CallExpression")
      writeTargets.add(node["callee"] as AstNode);
    if (node.type === "UnaryExpression" && node["operator"] === "delete")
      writeTargets.add(node["argument"] as AstNode);
    if (node.type === "ForOfStatement" || node.type === "ForInStatement")
      writeTargets.add(node["left"] as AstNode);
    if (isAbortRead(node) && !writeTargets.has(node)) {
      const object = node["object"] as AstNode;
      edits.push({
        start: object.start,
        end: object.start,
        text: "globalThis.__specAborted(__specF,",
        kind: "open",
      });
      edits.push({
        start: object.end,
        end: node.end,
        text: `,${String(node["optional"] === true)},${JSON.stringify((node["property"] as AstNode)["name"])})`,
        kind: "replace",
      });
      visit(object, inside);

      return;
    }
    if (isComputedEnvRead(node)) {
      const key = node["property"] as AstNode;
      edits.push(
        {
          start: node.start,
          end: key.start,
          text: "((__specK)=>globalThis.__specEnv(__specF,__specK,process.env[__specK]))(",
          kind: "replace",
        },
        { start: key.end, end: node.end, text: ")", kind: "replace" },
      );
      for (const value of [key]) visit(value, inside);

      return;
    }
    if (isEnvRead(node)) {
      const name = String((node["property"] as AstNode)["name"]);
      edits.push({
        start: node.start,
        end: node.end,
        text: `globalThis.__specEnv(__specF,${JSON.stringify(name)},process.env.${name})`,
        kind: "replace",
      });

      return;
    }
    if (isEnvWriteTarget(node)) return;
    if (node.type === "NewExpression") {
      edits.push(...oneNew(node, source, inside));
    } else if (node.type === "CallExpression") {
      edits.push(
        ...oneCall(
          node,
          source,
          locals,
          inside || detached,
          detached && !inside,
          awaited && !inside ? scope : "none",
        ),
      );
    }
    const unawaited =
      (node.type === "UnaryExpression" && node["operator"] === "void") ||
      node.type === "ExpressionStatement";
    const below = scopeBelow(node, scope, late);
    for (const [key, value] of Object.entries(node)) {
      const waits = below !== "none" && awaitedChild(node, key, awaited);
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (!isNode(item)) return;
          // A later element runs while this one's window is open.
          const quiet = !waits || !value.slice(index + 1).some(hasWrite);
          visit(item, inside, false, waits && quiet, below);
        });
      } else if (isNode(value)) {
        visit(
          value,
          inside,
          unawaited && value.type === "CallExpression",
          waits,
          below,
        );
      }
    }
  };
  visit(body, false, false, body.type !== "BlockStatement");

  return edits;
}

function isAbortRead(node: AstNode): boolean {
  return (
    node.type === "MemberExpression" &&
    node["computed"] !== true &&
    (node["optional"] === true ||
      !hasOptionalLink(node["object"] as AstNode)) &&
    ["aborted", "closed"].includes(
      String((node["property"] as AstNode)["name"]),
    )
  );
}

function isComputedEnvRead(node: AstNode): boolean {
  if (node.type !== "MemberExpression" || node["computed"] !== true)
    return false;
  const object = node["object"] as AstNode;
  if (object.type !== "MemberExpression" || object["computed"] === true)
    return false;
  const root = object["object"] as AstNode;

  return (
    root.type === "Identifier" &&
    root["name"] === "process" &&
    (object["property"] as AstNode)["name"] === "env"
  );
}

function isEnvRead(node: AstNode): boolean {
  if (node.type !== "MemberExpression" || node["computed"] === true)
    return false;
  const object = node["object"] as AstNode;
  if (object.type !== "MemberExpression" || object["computed"] === true)
    return false;
  const root = object["object"] as AstNode;

  return (
    root.type === "Identifier" &&
    root["name"] === "process" &&
    (object["property"] as AstNode)["name"] === "env"
  );
}

// An assignment target or `delete` cannot be read through a helper, so its subtree is left alone.
function isEnvWriteTarget(node: AstNode): boolean {
  const anyEnv = (item: AstNode): boolean =>
    isEnvRead(item) || isComputedEnvRead(item);
  if (node.type === "AssignmentExpression")
    return anyEnv(node["left"] as AstNode);
  if (node.type === "UnaryExpression" && node["operator"] === "delete")
    return anyEnv(node["argument"] as AstNode);

  return false;
}

// Closures handed to something outside the function are callbacks: that something decides when
// they run and with what, so the function's behaviour depends on it. Each maps to its label.
function escapedClosures(body: AstNode): Map<AstNode, string> {
  const found = new Map<AstNode, string>();
  const locals = localDeclarations(body);
  const objects = localObjects(body);
  walk(body, (node) => {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
    if (isInlineCall(node)) return;
    (node["arguments"] as AstNode[]).forEach((arg, index) => {
      note(found, locals, arg, `arg${index}`);
      scanObject(found, locals, objects, arg, new Set());
    });
  });

  return found;
}

// Callbacks can sit in an options object, nested, spread, or built earlier in a local variable.
function scanObject(
  found: Map<AstNode, string>,
  locals: Map<string, AstNode>,
  objects: Map<string, AstNode>,
  value: AstNode,
  seen: Set<AstNode>,
): void {
  const target =
    value.type === "Identifier" ? objects.get(value["name"] as string) : value;
  if (!target || target.type !== "ObjectExpression" || seen.has(target)) return;
  seen.add(target);
  for (const property of target["properties"] as AstNode[]) {
    if (property.type === "SpreadElement") {
      scanObject(found, locals, objects, property["argument"] as AstNode, seen);
      continue;
    }
    if (property.type !== "Property") continue;
    const key = property["key"] as { name?: string; value?: unknown };
    const item = property["value"] as AstNode;
    note(
      found,
      locals,
      item,
      String(
        (key.name as string | undefined) ??
          (key.value as string | undefined) ??
          "property",
      ),
    );
    scanObject(found, locals, objects, item, seen);
  }
}

function localObjects(body: AstNode): Map<string, AstNode> {
  const names = new Map<string, AstNode>();
  walk(body, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const id = node["id"] as { name?: string };
    const init = node["init"] as AstNode | null;
    if (id.name && init?.type === "ObjectExpression") names.set(id.name, init);
  });

  return names;
}

function note(
  found: Map<AstNode, string>,
  locals: Map<string, AstNode>,
  value: AstNode,
  label: string,
): void {
  if (value.type === "LogicalExpression") {
    note(found, locals, value["left"] as AstNode, label);
    note(found, locals, value["right"] as AstNode, label);
  } else if (value.type === "ConditionalExpression") {
    note(found, locals, value["consequent"] as AstNode, label);
    note(found, locals, value["alternate"] as AstNode, label);
  } else if (value.type === "ParenthesizedExpression") {
    note(found, locals, value["expression"] as AstNode, label);
  } else if (isClosure(value)) found.set(value, label);
  else if (value.type === "Identifier") {
    const local = locals.get(value["name"] as string);
    if (local) found.set(local, value["name"] as string);
  }
}

// A local helper a callback calls runs inside that callback, so its effects are the callback's too.
function withCallbackHelpers(
  body: AstNode,
  escaped: Map<AstNode, string>,
): Map<AstNode, string> {
  const locals = localDeclarations(body);
  const all = new Map(escaped);
  const pending = [...escaped.keys()];
  while (pending.length > 0) {
    const closure = pending.pop();
    if (!closure) continue;
    walk(closure, (node) => {
      if (node.type !== "CallExpression") return;
      const callee = node["callee"] as AstNode;
      if (callee.type !== "Identifier") return;
      const helper = locals.get(callee["name"] as string);
      if (helper && !all.has(helper)) {
        all.set(helper, "helper");
        pending.push(helper);
      }
    });
  }

  return all;
}

// Whether the child under `key` hands its value straight to an `await` or `return`, so the rest
// of its statement runs only once the function resumes, past a probe.
function awaitedChild(node: AstNode, key: string, awaited: boolean): boolean {
  if (node.type === "AwaitExpression" || node.type === "ReturnStatement")
    return key === "argument";
  if (isClosure(node))
    return (
      key === "body" && (node["body"] as AstNode).type !== "BlockStatement"
    );
  if (!awaited) return false;
  if (TRANSPARENT.has(node.type)) return key === "expression";
  if (node.type === "ConditionalExpression") return key !== "test";
  if (node.type === "LogicalExpression")
    return key === "right" || !hasWrite(node["right"]);
  if (node.type === "ArrayExpression") return key === "elements";
  if (node.type === "MemberExpression") return key === "object";
  if (node.type !== "CallExpression") return false;
  const callee = node["callee"] as AstNode;
  if (callee.type !== "MemberExpression" || callee["computed"] === true)
    return false;
  const object = callee["object"] as AstNode;
  const name = String((callee["property"] as AstNode)["name"]);
  if (key === "callee") return SETTLE_CHAIN.has(name);

  return (
    key === "arguments" &&
    object.type === "Identifier" &&
    object["name"] === "Promise" &&
    PROMISE_COMBINATORS.has(name)
  );
}

// Only a closure directly in the function runs as a trace of its own; one inside it may run while
// that closure is still running.
function scopeBelow(node: AstNode, scope: Scope, late: Set<AstNode>): Scope {
  if (late.has(node) && scope === "own") return "late";
  if (isClosure(node) || SCOPES.has(node.type)) return "none";

  return scope;
}

function isClosure(node: AstNode): boolean {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  );
}

// `array.map(fn)` and the like run `fn` right here, as part of the function's own body.
function isInlineCall(node: AstNode): boolean {
  const callee = node["callee"] as AstNode;
  if (callee.type !== "MemberExpression") return false;
  const object = callee["object"] as AstNode;
  const name = String(
    ((callee["property"] as AstNode)["name"] as string | undefined) ?? "",
  );

  return (
    PURE_METHODS.has(name) ||
    INLINE_METHODS.has(name) ||
    (object.type === "Identifier" &&
      (object["name"] === "Promise" ||
        (object["name"] === "Array" && name === "from")))
  );
}

function localDeclarations(body: AstNode): Map<string, AstNode> {
  const names = new Map<string, AstNode>();
  walk(body, (node) => {
    if (node === body) return;
    if (node.type === "FunctionDeclaration") {
      const id = node["id"] as { name?: string } | null;
      if (id?.name) names.set(id.name, node);
    } else if (node.type === "VariableDeclarator") {
      const id = node["id"] as { name?: string };
      const init = node["init"] as AstNode | null;
      if (id.name && init && isClosure(init)) names.set(id.name, init);
    }
  });

  return names;
}

// A closure that outlives its function gets a trace of its own whenever it runs after that function
// returned. It is given what it can see of the function that made it, like module state.
function lateEdits(
  target: FunctionInfo,
  program: AstNode,
  body: AstNode,
  escaped: Map<AstNode, string>,
  mutable: Set<string>,
): Edit[] {
  const node = functionNode(program, target);
  const enclosing = declaredNames(body);
  for (const param of node ? parameterNames(node["params"] as AstNode[]) : [])
    enclosing.add(param);
  const counts = new Map<string, number>();
  const edits: Edit[] = [];
  const named = positionNames(body);
  const closures = [...lateClosures(body, escaped)].sort(
    ([a], [b]) => a.start - b.start,
  );
  for (const [closure, label] of closures) {
    const seen = (counts.get(label) ?? 0) + 1;
    counts.set(label, seen);
    const name = seen === 1 ? label : `${label}~${seen}`;
    const own = declaredNames(closure);
    for (const param of parameterNames(closure["params"] as AstNode[]))
      own.add(param);
    const free = [...mentioned(closure["body"] as AstNode)]
      .filter(
        (item) => !own.has(item) && (enclosing.has(item) || mutable.has(item)),
      )
      .sort();
    const thunks = free.map((item) => `${item}:()=>${item}`).join(",");
    edits.push(
      open(
        closure.start,
        `${LATE}(__specF,${JSON.stringify(name)},${JSON.stringify(named.get(closure) ?? "")},{${thunks}},`,
      ),
      close(closure.end, ")"),
    );
  }

  return edits;
}

// JavaScript names a closure after the property or variable it directly initialises, and only then.
function positionNames(body: AstNode): Map<AstNode, string> {
  const names = new Map<AstNode, string>();
  walk(body, (node) => {
    if (node.type === "Property" && node["computed"] !== true) {
      const key = node["key"] as { name?: string; value?: unknown };
      names.set(
        node["value"] as AstNode,
        String(
          (key.name as string | undefined) ??
            (key.value as string | undefined) ??
            "",
        ),
      );
    } else if (node.type === "VariableDeclarator") {
      const id = node["id"] as { name?: string };
      if (id.name && node["init"]) names.set(node["init"] as AstNode, id.name);
    }
  });

  return names;
}

function declaredNames(body: AstNode): Set<string> {
  const names = new Set<string>();
  walk(body, (node) => {
    if (node === body) return;
    if (node.type === "VariableDeclarator")
      for (const name of parameterNames([node["id"] as AstNode]))
        names.add(name);
    else if (node.type === "FunctionDeclaration") {
      const id = node["id"] as { name?: string } | null;
      if (id?.name) names.add(id.name);
    }
  });

  return names;
}

// Closures that can run after their function has returned: callbacks it handed out and closures it
// returned. A generator or a shorthand method cannot be wrapped where it stands.
function lateClosures(
  body: AstNode,
  escaped: Map<AstNode, string>,
): Map<AstNode, string> {
  const found = new Map(escaped);
  const locals = localDeclarations(body);
  const objects = localObjects(body);
  const noteReturned = (value: AstNode): void => {
    note(found, locals, value, "return");
    scanObject(found, locals, objects, value, new Set());
  };
  if (body.type !== "BlockStatement") noteReturned(body);
  walk(body, (node) => {
    if (node.type === "ReturnStatement" && node["argument"])
      noteReturned(node["argument"] as AstNode);
  });
  const shorthand = new Set<AstNode>();
  walk(body, (node) => {
    if (
      node.type === "Property" &&
      (node["method"] === true || node["kind"] !== "init")
    )
      shorthand.add(node["value"] as AstNode);
  });

  return new Map(
    [...found].filter(
      ([closure]) =>
        isClosure(closure) &&
        closure["generator"] !== true &&
        !shorthand.has(closure),
    ),
  );
}

// A private method runs inside its caller's trace, so a callback it is handed is the caller's own
// code, not something outside the function.
function inlinedCallbacks(target: FunctionInfo, program: AstNode): string[] {
  const node = target.isPrivate ? functionNode(program, target) : undefined;

  return node ? parameterNames(node["params"] as AstNode[]) : [];
}

function escapeEdits(escaped: Map<AstNode, string>): Edit[] {
  const edits: Edit[] = [];
  for (const [closure, label] of escaped) {
    const body = closure["body"] as AstNode;
    const names = parameterNames(closure["params"] as AstNode[]);
    const entry = `${ENTER}(__specF,${JSON.stringify(label)},[${names.join(",")}])`;
    if (body.type === "BlockStatement") {
      edits.push(open(body.start + 1, `${entry};`));
    } else {
      edits.push(open(body.start, `(${entry},`), close(body.end, ")"));
    }
  }

  return edits;
}

// What the closure can see of its arguments, as expressions valid at the top of its body.
function parameterNames(params: AstNode[]): string[] {
  const bindings = (node: AstNode): string[] => {
    if (node.type === "Identifier") return [node["name"] as string];
    if (node.type === "AssignmentPattern")
      return bindings(node["left"] as AstNode);
    if (node.type === "RestElement")
      return bindings(node["argument"] as AstNode);
    if (node.type === "ArrayPattern") {
      return (node["elements"] as (AstNode | null)[]).flatMap((element) =>
        element ? bindings(element) : [],
      );
    }
    if (node.type === "ObjectPattern") {
      return (node["properties"] as AstNode[]).flatMap((property) =>
        property.type === "RestElement"
          ? bindings(property)
          : bindings(property["value"] as AstNode),
      );
    }
    if (node.type === "TSParameterProperty")
      return bindings(node["parameter"] as AstNode);

    return [];
  };

  return params.flatMap(bindings).filter((name) => name !== "this");
}

function oneNew(node: AstNode, source: string, nested: boolean): Edit[] {
  const callee = node["callee"] as AstNode;
  const args = node["arguments"] as AstNode[];
  if (
    callee.type === "Identifier" &&
    callee["name"] === "Date" &&
    args.length === 0
  ) {
    return [
      {
        start: node.start,
        end: node.end,
        text: `new Date(globalThis.__specNow(__specF,${String(nested)}))`,
        kind: "replace",
      },
    ];
  }
  if (callee.type !== "Identifier" && callee.type !== "MemberExpression")
    return [];
  if (containsCall(callee)) return [];
  const text = source.slice(callee.start, callee.end);
  const label = JSON.stringify(`new ${text.replace(/\s+/g, " ")}`);
  const wrapper = `${NEW}(__specF,${label},${text},${String(nested)})`;
  const hasArguments = source[node.end - 1] === ")";
  const paren = hasArguments ? argumentsOpen(node, source) : -1;
  if (paren === -1) {
    return [
      {
        start: node.start,
        end: node.end,
        text: `${wrapper}()`,
        kind: "replace",
      },
    ];
  }

  return [{ start: node.start, end: paren, text: wrapper, kind: "replace" }];
}

// A callback's effects happen inside something else's run. A `void` call only stops being waited
// for, so its place in the order of the function's own work is real. An awaited one is not cut
// short at its return.
function nestedText(
  nested: boolean,
  detached: boolean,
  awaited: Scope,
): string {
  if (detached) return '"detached"';
  if (awaited === "own" && !nested) return '"awaited"';
  if (awaited === "late" && !nested) return '"awaited-late"';

  return String(nested);
}

function hasWrite(node: unknown): boolean {
  if (!isNode(node)) return false;
  let found = false;
  walk(node, (current) => {
    if (
      current.type === "AssignmentExpression" ||
      current.type === "UpdateExpression" ||
      (current.type === "UnaryExpression" && current["operator"] === "delete")
    )
      found = true;
  });

  return found;
}

function containsCall(node: AstNode): boolean {
  let found = false;
  walk(node, (current) => {
    if (current.type === "CallExpression") found = true;
  });

  return found;
}

function oneCall(
  node: AstNode,
  source: string,
  locals: Set<string>,
  nested: boolean,
  detached: boolean,
  awaited: Scope,
): Edit[] {
  let callee = node["callee"] as AstNode;
  const open_ = argumentsOpen(node, source);
  if (open_ === -1) return [];
  while (
    callee.type === "TSInstantiationExpression" ||
    callee.type === "TSNonNullExpression"
  ) {
    callee = callee["expression"] as AstNode;
  }
  const label = JSON.stringify(
    source.slice(callee.start, callee.end).replace(/\s+/g, " "),
  );
  const optionalCall = node["optional"] === true;
  const callText = optionalCall ? "?." : "";
  if (callee.type === "Identifier") {
    const name = callee["name"] as string;
    if (locals.has(name) || name === "require" || name === "eval") return [];

    return [
      {
        start: callee.start,
        end: open_,
        text: `${CALL}(__specF,${label},${name},${nestedText(nested, detached, awaited)})${callText}`,
        kind: "replace",
      },
    ];
  }
  if (callee.type === "CallExpression") {
    return [
      {
        start: callee.start,
        end: callee.start,
        text: `${CALL}(__specF,${label},`,
        kind: "open",
      },
      {
        start: callee.end,
        end: open_,
        text: `,${nestedText(nested, detached, awaited)})${callText}`,
        kind: "replace",
      },
    ];
  }
  if (callee.type !== "MemberExpression") return [];
  const object = callee["object"] as AstNode;
  const property = callee["property"] as AstNode;
  if (object.type === "Super" || property.type === "PrivateIdentifier")
    return [];
  // `a?.b.c()`: only the whole chain may skip, and a helper cannot see where `a?.b` stopped.
  if (hasOptionalLink(object)) return [];
  const optionalObject = callee["optional"] === true;
  // The key would run before the helper could short-circuit.
  if (optionalObject && callee["computed"] === true) return [];
  const mode = `${String(optionalObject)},${String(optionalCall)},${nestedText(nested, detached, awaited)}`;
  const skip = optionalObject || optionalCall ? "?." : "";
  const prefix = {
    start: object.start,
    end: object.start,
    text: `${METHOD}(__specF,${label},`,
    kind: "open" as const,
  };
  if (callee["computed"] === true) {
    return [
      prefix,
      {
        start: object.end,
        end: property.start,
        text: ",",
        kind: "replace",
      },
      {
        start: property.end,
        end: open_,
        text: `,${mode})${skip}`,
        kind: "replace",
      },
    ];
  }

  return [
    prefix,
    {
      start: object.end,
      end: open_,
      text: `,${JSON.stringify(property["name"])},${mode})${skip}`,
      kind: "replace",
    },
  ];
}

// Offset of the call's own `(`, past the callee, type arguments and any comment in between.
function argumentsOpen(node: AstNode, source: string): number {
  const callee = node["callee"] as AstNode;
  const generics = node["typeArguments"] as AstNode | null | undefined;
  let index = generics?.end ?? callee.end;
  while (index < node.end) {
    if (source.startsWith("/*", index)) {
      index = source.indexOf("*/", index) + 2;
    } else if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index) + 1;
    } else if (source[index] === "(") {
      return index;
    } else {
      index += 1;
    }
  }

  return -1;
}

// True when the receiver chain itself has a `?.`.
export function hasOptionalLink(object: AstNode): boolean {
  let current: AstNode | undefined = object;
  while (current) {
    if (current["optional"] === true) return true;
    if (current.type === "MemberExpression")
      current = current["object"] as AstNode;
    else if (current.type === "CallExpression")
      current = current["callee"] as AstNode;
    else return false;
  }

  return false;
}

// Static check, shared with coverage: the calls in a function the tracer cannot see, other than
// built-in methods. A function with any of these cannot earn traced credit.
export function unobservedCalls(body: AstNode): string[] {
  const found: string[] = [];
  walk(body, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node["callee"] as AstNode;
    if (callee.type !== "MemberExpression") return;
    const object = callee["object"] as AstNode;
    const property = callee["property"] as AstNode;
    const skipped =
      hasOptionalLink(object) ||
      (callee["optional"] === true && callee["computed"] === true);
    if (
      skipped &&
      !PURE_METHODS.has(String((property["name"] as string | undefined) ?? ""))
    ) {
      found.push(
        String((property["name"] as string | undefined) ?? "computed"),
      );
    }
  });

  return found;
}

// Helpers declared inside a function are part of its body, so calls to them are not its effects.
function localFunctions(body: AstNode): Set<string> {
  const names = new Set<string>();
  walk(body, (node) => {
    if (node === body) return;
    if (node.type === "FunctionDeclaration") {
      const id = node["id"] as { name?: string } | null;
      if (id?.name) names.add(id.name);
    } else if (node.type === "VariableDeclarator") {
      const id = node["id"] as { name?: string };
      const init = node["init"] as AstNode | null;
      if (
        id.name &&
        (init?.type === "ArrowFunctionExpression" ||
          init?.type === "FunctionExpression")
      ) {
        names.add(id.name);
      }
    }
  });

  return names;
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) walk(item, visit);
      }
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function isNode(value: unknown): value is AstNode {
  return typeof (value as AstNode | null)?.type === "string";
}

// Edits never nest in a range: `open` and `close` insert, and a `replace` covers only text with
// no other edit in it. At one offset the text reads closes (inner first), opens (outer first),
// then the replacement, so any overlap is a bug in this file and stops the load.
function applyEdits(source: string, edits: Edit[]): string {
  const ordered = edits
    .map((edit, index) => ({ edit: edit, index: index }))
    .sort(
      (a, b) =>
        a.edit.start - b.edit.start ||
        RANK[a.edit.kind] - RANK[b.edit.kind] ||
        (a.edit.kind === "close" ? b.index - a.index : a.index - b.index),
    );
  let text = "";
  let cursor = 0;
  for (const { edit } of ordered) {
    if (edit.start < cursor)
      throw new Error(`overlapping edit at ${edit.start}`);
    text += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }

  return text + source.slice(cursor);
}
