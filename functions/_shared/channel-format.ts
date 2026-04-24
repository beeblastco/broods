/**
 * Channel-specific text formatting helpers.
 * Keep generic markdown-ish assistant output readable on channels with different rendering rules.
 */

export function formatSlackMessage(text: string): string {
  return mapTextSegments(text, (segment) =>
    transformSlackLines(replaceMarkdownTables(segment)),
  ).trim();
}

export function formatDiscordMessage(text: string): string {
  return mapTextSegments(text, replaceMarkdownTables).trim();
}

function mapTextSegments(
  text: string,
  formatter: (segment: string) => string,
): string {
  const parts: string[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(/```[\s\S]*?```/g)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push(formatter(text.slice(lastIndex, index)));
    }

    parts.push(match[0]);
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(formatter(text.slice(lastIndex)));
  }

  return parts.join("");
}

function replaceMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (
      isMarkdownTableRow(lines[index]) &&
      index + 1 < lines.length &&
      isMarkdownTableSeparator(lines[index + 1])
    ) {
      const tableLines = [lines[index]!, lines[index + 1]!];
      index += 2;

      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        tableLines.push(lines[index]!);
        index += 1;
      }

      index -= 1;
      output.push(renderMarkdownTable(tableLines));
      continue;
    }

    output.push(lines[index]!);
  }

  return output.join("\n");
}

function transformSlackLines(text: string): string {
  return text
    .split("\n")
    .map((line) => formatSlackLine(line))
    .join("\n");
}

function formatSlackLine(line: string): string {
  if (/^\s*---+\s*$/.test(line)) {
    return "";
  }

  const headingMatch = line.match(/^(\s*)#{1,6}\s+(.+)$/);
  if (headingMatch) {
    return `${headingMatch[1]}*${stripSlackHeadingMarkup(headingMatch[2]!.trim())}*`;
  }

  const bulletMatch = line.match(/^(\s*)[*-]\s+(.+)$/);
  if (bulletMatch) {
    return `${bulletMatch[1]}• ${formatSlackInline(bulletMatch[2]!)}`;
  }

  return formatSlackInline(line);
}

function formatSlackInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*");
}

function stripSlackHeadingMarkup(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .trim();
}

function renderMarkdownTable(lines: string[]): string {
  const rows = lines
    .filter((line) => !isMarkdownTableSeparator(line))
    .map((line) => parseMarkdownTableRow(line));

  if (rows.length === 0) {
    return lines.join("\n");
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...rows.map((row) => (row[columnIndex] ?? "").length), 3),
  );

  const renderRow = (row: string[]) =>
    row
      .map((cell, columnIndex) => (cell ?? "").padEnd(widths[columnIndex]!))
      .join(" | ");

  const header = renderRow(rows[0]!);
  const separator = widths.map((width) => "-".repeat(width)).join("-|-");
  const body = rows.slice(1).map((row) => renderRow(row));

  return `\`\`\`text\n${[header, separator, ...body].join("\n")}\n\`\`\``;
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string | undefined): boolean {
  return typeof line === "string"
    && /^\s*\|.*\|\s*$/.test(line)
    && line.includes("|");
}

function isMarkdownTableSeparator(line: string | undefined): boolean {
  return typeof line === "string"
    && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}
