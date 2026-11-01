import { defineRule, type Comment } from "@oxlint/plugins";

type Limits = { maxLines: number; maxColumns: number };

const TS_FILE_PATTERN = /\.[cm]?tsx?$/u;
const DIRECTIVE_PATTERN =
  /^\s*\*?\s*(?:(?:oxlint|eslint)-|@ts-|\/\s*<reference\s|prettier-ignore|oxfmt-ignore|biome-ignore|c8 |istanbul |[@#]__PURE__|@jsx|@vitest-environment|webpack[A-Z]|#(?:end)?region\b)/u;
const DIVIDER_LINE_PATTERN =
  /^(?:[-=*#~_/+─━═\s]{3,}|(?:[-=*~_/+]{3,}|[─━═]{2,})\s.*|.*\s[-=*#~_─━═]{3,})$/u;
const TEST_STEP_PATTERN = /^(?:arrange|act|assert|given|when|then)\s*[:.]?$/iu;
const TASK_MARKER_PATTERN = /(?:^|\s)(?:TODO|FIXME|XXX|HACK)(?=[\s:(.,!]|$)/mu;
const TASK_LINK_PATTERN = /#\d+|https?:\/\//u;
const URL_PATTERN = /https?:\/\/\S+/gu;
const LICENSE_PATTERN =
  /^!|@license|\bcopyright\b|\bSPDX-License-Identifier\b/iu;
const JSDOC_TYPE_PATTERN = /^@(?:param|returns?|type|typedef)\s+\{/u;
const EMPTY_JSDOC_TAG_PATTERN =
  /^@(?:param(?:\s+\[?[\w$.]+\]?)?(?:\s+-)?|returns?)$/u;
const COMMENTED_CODE_PATTERN =
  /^(?:(?:(?:const|let|var)\s+[\w${}[\], ]+=.*|import\s.+\sfrom\s+["'].+["']|(?:await\s+|return\s+)?[\w$.]+\(.*\)|[\w$.[\]]+\s*=\s*.+|(?:return|throw)(?:\s+.+)?|break|continue);|(?:if|for|while|switch)\s*\(.*\)\s*\{|\}(?:\s*else\s*\{)?)$/u;
const DECLARATION_PATTERN =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:static\s+)?(?:readonly\s+)?(?:(?:const|let|var|function\*?|class|interface|type|enum)\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*[:=(<{]/u;
const FILLER_WORDS = new Set(
  "a an the of for to in on at by with from and or is are be this that it its as get set return create new current value given whether".split(
    " ",
  ),
);

const stem = (word: string): string =>
  word.length > 3 ? word.replace(/([^s])s$/u, "$1") : word;
const words = (text: string): Array<string> =>
  (text.toLowerCase().match(/[a-z0-9]+/gu) ?? [])
    .filter((word) => !FILLER_WORDS.has(word))
    .map(stem)
    .filter((word) => !FILLER_WORDS.has(word));
const identifierWords = (name: string): Array<string> =>
  words(
    name
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2"),
  );
const commentLines = (comment: Comment): Array<string> =>
  comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/u, "").trim())
    .filter((line) => line !== "");

interface Group {
  readonly comments: Array<Comment>;
  readonly lines: Array<string>;
}

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Reject comments that repeat the code, divide sections, narrate tests or run long.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxLines: { type: "integer", minimum: 1 },
          maxColumns: { type: "integer", minimum: 40 },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ maxLines: 4, maxColumns: 100 }],
  },
  create: (context) => {
    const { sourceCode } = context;
    const { maxLines, maxColumns } = context.options[0] as Limits;
    const isTypeScript = TS_FILE_PATTERN.test(context.filename);
    const ownLine = (comment: Comment): boolean =>
      (sourceCode.lines[comment.loc.start.line - 1] ?? "")
        .slice(0, comment.loc.start.column)
        .trim() === "";

    const groups: Array<Group> = [];
    let previous: Comment | undefined;
    for (const comment of sourceCode.getAllComments()) {
      if (comment.type === "Shebang" || DIRECTIVE_PATTERN.test(comment.value)) {
        previous = undefined;
        continue;
      }
      const group = groups.at(-1);
      const continues =
        group !== undefined &&
        comment.type === "Line" &&
        previous?.type === "Line" &&
        previous.loc.end.line === comment.loc.start.line - 1 &&
        previous.loc.start.column === comment.loc.start.column;
      if (continues) {
        group.comments.push(comment);
        group.lines.push(...commentLines(comment));
      } else {
        groups.push({ comments: [comment], lines: commentLines(comment) });
      }
      previous = comment;
    }

    const restatesNextName = ({ comments, lines }: Group): boolean => {
      const last = comments.at(-1);
      if (last === undefined || !ownLine(last)) return false;
      if (lines.some((line) => line.startsWith("@"))) return false;
      const next = sourceCode.lines[last.loc.end.line] ?? "";
      const name = DECLARATION_PATTERN.exec(next)?.[1];
      if (name === undefined) return false;
      const content = words(lines.join(" "));
      if (content.length === 0 || content.length > 6) return false;
      const nameWords = new Set(identifierWords(name));
      return content.every((word) => nameWords.has(word));
    };

    const problem = (group: Group): string | undefined => {
      const { comments, lines } = group;
      const text = comments.map((comment) => comment.value).join("\n");
      const isLine = comments[0]?.type === "Line";
      if (lines.some((line) => DIVIDER_LINE_PATTERN.test(line))) {
        return "Drop the section divider; split the file or let the code's structure show the grouping.";
      }
      if (
        isLine &&
        lines.length === 1 &&
        TEST_STEP_PATTERN.test(lines[0] ?? "")
      ) {
        return "Drop the test step label.";
      }
      if (TASK_MARKER_PATTERN.test(text) && !TASK_LINK_PATTERN.test(text)) {
        return "Link the issue that tracks this (#123 or a URL), or drop the marker.";
      }
      if (isTypeScript && lines.some((line) => JSDOC_TYPE_PATTERN.test(line))) {
        return "Drop the JSDoc type; TypeScript already has it.";
      }
      if (lines.some((line) => EMPTY_JSDOC_TAG_PATTERN.test(line))) {
        return "Drop the JSDoc tag that has no description.";
      }
      if (isLine && lines.every((line) => COMMENTED_CODE_PATTERN.test(line))) {
        return "Delete commented-out code; git keeps the history.";
      }
      if (restatesNextName(group)) {
        return "Drop the comment; it only repeats the name below it. Say why, or say nothing.";
      }
      if (lines.length > maxLines && !LICENSE_PATTERN.test(text)) {
        return `Cut this to ${maxLines} lines or fewer: keep the constraint, drop the background.`;
      }
      return undefined;
    };

    const firstWideLine = ({ comments }: Group): number | undefined => {
      for (const { loc } of comments) {
        for (let line = loc.start.line; line <= loc.end.line; line++) {
          const source = sourceCode.lines[line - 1] ?? "";
          const end = line === loc.end.line ? loc.end.column : source.length;
          const width = source.slice(0, end).replace(URL_PATTERN, "").length;
          if (width > maxColumns) return line;
        }
      }
      return undefined;
    };

    return {
      Program: (): void => {
        for (const group of groups) {
          if (group.lines.length === 0) continue;
          const first = group.comments[0];
          const last = group.comments.at(-1);
          if (first === undefined || last === undefined) continue;
          const message = problem(group);
          if (message !== undefined) {
            context.report({
              loc: { start: first.loc.start, end: last.loc.end },
              message: message,
            });
          }
          const wide = firstWideLine(group);
          if (wide !== undefined) {
            context.report({
              loc: { line: wide, column: 0 },
              message: `Wrap the comment at ${maxColumns} columns; a long line is not a way around the line cap.`,
            });
          }
        }
      },
    };
  },
});
