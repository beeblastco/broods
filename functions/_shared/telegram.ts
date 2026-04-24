/**
 * Telegram transport helpers.
 * Telegram low-level API calls and formatting.
 */

import { timingSafeEqual } from "node:crypto";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    first_name: string;
    username?: string;
    is_bot: boolean;
  };
  chat: {
    id: number;
    type: string;
  };
  date: number;
  text?: string;
}

export function verifyWebhookSecret(
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tableToHtml(block: string): string {
  const lines = block.trim().split("\n").filter((line) => line.trim());
  const rows: string[][] = [];
  for (const line of lines) {
    if (/^\|[\s\-:|]+\|/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    rows.push(cells);
  }
  if (rows.length === 0) return escapeHtml(block);

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array(columnCount).fill(1);
  for (const row of rows) {
    for (let index = 0; index < row.length && index < columnCount; index += 1) {
      widths[index] = Math.max(widths[index]!, row[index]!.length);
    }
  }

  const rule = (left: string, middle: string, right: string, fill: string) =>
    left + widths.map((width: number) => fill.repeat(width + 2)).join(middle) + right;

  const formatRow = (cells: string[]) =>
    "│" +
    Array.from({ length: columnCount }, (_, index) => {
      const cell = index < cells.length ? cells[index]! : "";
      return ` ${cell.padEnd(widths[index]!)} `;
    }).join("│") +
    "│";

  const output = [rule("┌", "┬", "┐", "─"), formatRow(rows[0]!)];
  if (rows.length > 1) {
    output.push(rule("├", "┼", "┤", "─"));
    for (const row of rows.slice(1)) output.push(formatRow(row));
  }
  output.push(rule("└", "┴", "┘", "─"));
  return `<pre>${escapeHtml(output.join("\n"))}</pre>`;
}

function richToHtml(text: string): string {
  const parts: string[] = [];
  for (const part of text.split(/(\[[^\]]+\]\([^)]+\))/)) {
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const href = linkMatch[2]!;
      if (/^https?:\/\//i.test(href)) {
        parts.push(`<a href="${escapeHtml(href)}">${escapeHtml(linkMatch[1]!)}</a>`);
      } else {
        parts.push(escapeHtml(part));
      }
    } else {
      let escaped = escapeHtml(part);
      escaped = escaped.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
      escaped = escaped.replace(/__(.+?)__/gs, "<b>$1</b>");
      escaped = escaped.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
      escaped = escaped.replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, "<i>$1</i>");
      parts.push(escaped);
    }
  }
  return parts.join("");
}

function inlineToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) return `<b>${escapeHtml(headingMatch[1]!)}</b>`;

      return line
        .split(/(`[^`\n]+`)/)
        .map((part) => {
          if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
            return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
          }
          return richToHtml(part);
        })
        .join("");
    })
    .join("\n");
}

function markdownToHtml(text: string): string {
  const result: string[] = [];
  let lastIndex = 0;
  const pattern = /```(\w*)\n?(.*?)```|((?:^\|.+\|\s*\n)+)/gms;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      result.push(inlineToHtml(text.slice(lastIndex, index)));
    }

    if (match[3] !== undefined) {
      result.push(tableToHtml(match[3]));
    } else {
      const language = (match[1] ?? "").trim();
      const code = escapeHtml((match[2] ?? "").trimEnd());
      result.push(
        language
          ? `<pre><code class="language-${language}">${code}</code></pre>`
          : `<pre>${code}</pre>`,
      );
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push(inlineToHtml(text.slice(lastIndex)));
  }

  return result.join("");
}

function splitHtmlChunks(html: string, maxLen: number = 4096): string[] {
  if (html.length <= maxLen) return [html];
  const chunks: string[] = [];
  let remaining = html;
  while (remaining) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
): Promise<void> {
  const html = markdownToHtml(text);
  const chunks = splitHtmlChunks(html);

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  for (const chunk of chunks) {
    let response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML" }),
    });
    if (!response.ok) {
      const plain = chunk.replace(/<[^>]*>/g, "").trim() || "(empty message)";
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: plain }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
      }
    }
  }
}
