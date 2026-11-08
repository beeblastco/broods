import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSync } from "oxc-parser";

export const ROOT = resolve(import.meta.dir, "../..");

export interface FunctionInfo {
  source: string;
  file: string;
  name: string;
  kind: "function" | "const" | "method";
  exported: boolean;
  isAsync: boolean;
  wrappable: boolean;
  isPrivate: boolean;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  loc: number;
}

export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export type SiteSlot = "list" | "single" | "expression";

export interface StatementSite {
  node: AstNode;
  slot: SiteSlot;
  line: number;
  owner: string | undefined;
}

export type ArmKind = "if-true" | "if-false" | "ternary" | "logical" | "case";

export interface ArmSite {
  // The node whose start identifies the arm. For an `if` with no `else`, the `if` itself.
  node: AstNode;
  kind: ArmKind;
  implicit: boolean;
  line: number;
  owner: string | undefined;
  // Set for an implicit `else`: offset of the consequent it is the opposite of.
  consequent: number | undefined;
}

export interface FileAnalysis {
  program: AstNode;
  functions: FunctionInfo[];
  statements: StatementSite[];
  arms: ArmSite[];
}

const FUNCTION_NODES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const SINGLE_SLOTS: Record<string, readonly string[]> = {
  IfStatement: ["consequent", "alternate"],
  ForStatement: ["body"],
  ForInStatement: ["body"],
  ForOfStatement: ["body"],
  WhileStatement: ["body"],
  DoWhileStatement: ["body"],
};
const NOT_EXECUTABLE = new Set([
  "BlockStatement",
  "EmptyStatement",
  "FunctionDeclaration",
  "ClassDeclaration",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSEnumDeclaration",
  "TSDeclareFunction",
]);

// Lists a file's named top-level functions, consts holding a function, and class methods. A
// replay's source id is `path#name`, or `path#Class.method` for a method.
export function listFunctions(
  file: string,
  text = readFileSync(join(ROOT, file), "utf8"),
): FunctionInfo[] {
  const parsed = parseSync(file, text);
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }

    return low + 1;
  };
  const found: FunctionInfo[] = [];
  const add = (
    name: string,
    kind: FunctionInfo["kind"],
    exported: boolean,
    isAsync: boolean,
    node: AstNode,
    wrappable = true,
    isPrivate = false,
  ): void => {
    const startLine = lineOf(node.start);
    const endLine = lineOf(Math.max(node.start, node.end - 1));
    found.push({
      source: `${file}#${name}`,
      file: file,
      name: name,
      kind: kind,
      exported: exported,
      isAsync: isAsync,
      wrappable: wrappable,
      isPrivate: isPrivate,
      start: node.start,
      end: node.end,
      startLine: startLine,
      endLine: endLine,
      loc: endLine - startLine + 1,
    });
  };
  const visit = (statement: AstNode, exported: boolean): void => {
    if (
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
    ) {
      const declaration = statement["declaration"] as AstNode | null;
      if (declaration) visit(declaration, true);

      return;
    }
    if (statement.type === "FunctionDeclaration") {
      const id = statement["id"] as { name: string } | null;
      if (id)
        add(
          id.name,
          "function",
          exported,
          statement["async"] === true,
          statement,
        );

      return;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement["declarations"] as AstNode[]) {
        const init = declarator["init"] as AstNode | null;
        const id = declarator["id"] as { name?: string };
        if (
          id.name &&
          (init?.type === "ArrowFunctionExpression" ||
            init?.type === "FunctionExpression")
        ) {
          add(id.name, "const", exported, init["async"] === true, declarator);
        }
      }

      return;
    }
    if (statement.type === "ClassDeclaration") {
      const id = statement["id"] as { name: string } | null;
      const body = statement["body"] as { body: AstNode[] };
      for (const member of body.body) {
        const key = member["key"] as { name?: string } | undefined;
        const value = member["value"] as AstNode | undefined;
        if (member.type === "MethodDefinition" && key?.name && id && value) {
          // Reading an accessor or a private-field method off the prototype would run it.
          const isPrivate = (key as AstNode).type === "PrivateIdentifier";
          const plainMethod =
            member["kind"] === "method" &&
            member["static"] !== true &&
            !isPrivate;
          add(
            `${id.name}.${isPrivate ? "#" : ""}${key.name}`,
            "method",
            exported,
            value["async"] === true,
            member,
            plainMethod,
            isPrivate,
          );
        }
      }
    }
  };
  for (const statement of parsed.program.body as unknown as AstNode[])
    visit(statement, false);

  return found;
}

// Lists every executable statement and branch arm inside any function in the file, in source
// order with the outer one first. Coverage counts these, so imports, types, comments and module
// constants never appear. `owner` is the listed function around the site, if there is one.
export function analyzeFile(file: string, text: string): FileAnalysis {
  const program = parseSync(file, text).program as unknown as AstNode;
  const functions = listFunctions(file, text);
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }

    return low + 1;
  };
  const ownerOf = (offset: number): string | undefined =>
    functions.find((entry) => entry.start <= offset && offset < entry.end)
      ?.source;
  const analysis: FileAnalysis = {
    program: program,
    functions: functions,
    statements: [],
    arms: [],
  };
  const statement = (node: AstNode, slot: SiteSlot): void => {
    if (NOT_EXECUTABLE.has(node.type) || node["directive"]) return;
    analysis.statements.push({
      node: node,
      slot: slot,
      line: lineOf(node.start),
      owner: ownerOf(node.start),
    });
  };
  const arm = (
    node: AstNode,
    kind: ArmKind,
    implicit = false,
    consequent?: number,
  ): void => {
    analysis.arms.push({
      node: node,
      kind: kind,
      implicit: implicit,
      line: lineOf(node.start),
      owner: ownerOf(node.start),
      consequent: consequent,
    });
  };
  const visit = (node: AstNode, inside: boolean): void => {
    if (inside) {
      if (node.type === "BlockStatement") {
        for (const item of node["body"] as AstNode[]) statement(item, "list");
      } else if (node.type === "SwitchCase") {
        for (const item of node["consequent"] as AstNode[])
          statement(item, "list");
        arm(node, "case");
      } else if (node.type === "ConditionalExpression") {
        arm(node["consequent"] as AstNode, "ternary");
        arm(node["alternate"] as AstNode, "ternary");
      } else if (node.type === "LogicalExpression") {
        arm(node["right"] as AstNode, "logical");
      } else if (node.type === "IfStatement") {
        const consequent = node["consequent"] as AstNode;
        const alternate = node["alternate"] as AstNode | null;
        arm(consequent, "if-true");
        if (alternate) arm(alternate, "if-false");
        else arm(node, "if-false", true, consequent.start);
      }
      for (const slot of SINGLE_SLOTS[node.type] ?? []) {
        const child = node[slot] as AstNode | null;
        if (child && child.type !== "BlockStatement")
          statement(child, "single");
      }
    }
    const nowInside = inside || FUNCTION_NODES.has(node.type);
    if (
      node.type === "ArrowFunctionExpression" &&
      (node["body"] as AstNode).type !== "BlockStatement"
    ) {
      statement(node["body"] as AstNode, "expression");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) visit(item, nowInside);
        }
      } else if (isNode(value)) {
        visit(value, nowInside);
      }
    }
  };
  visit(program, false);

  return analysis;
}

function isNode(value: unknown): value is AstNode {
  return typeof (value as AstNode | null)?.type === "string";
}
