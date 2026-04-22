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

export async function setMessageReaction(
  botToken: string,
  chatId: number,
  messageId: number,
  emoji: string = "\u{1F914}",
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/setMessageReaction`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram setMessageReaction failed (${response.status}): ${body}`);
  }
}

export async function sendChatAction(
  botToken: string,
  chatId: number,
  action: string = "typing",
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendChatAction`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendChatAction failed (${response.status}): ${body}`);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tableToHtml(block: string): string {
  const lines = block.trim().split("\n").filter((l) => l.trim());
  const rows: string[][] = [];
  for (const line of lines) {
    if (/^\|[\s\-:|]+\|/.test(line)) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    rows.push(cells);
  }
  if (rows.length === 0) return escapeHtml(block);

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array(colCount).fill(1);
  for (const row of rows) {
    for (let i = 0; i < row.length && i < colCount; i++) {
      widths[i] = Math.max(widths[i]!, row[i]!.length);
    }
  }

  const rule = (l: string, m: string, r: string, f: string) =>
    l + widths.map((w: number) => f.repeat(w + 2)).join(m) + r;

  const fmtRow = (cells: string[]) =>
    "│" +
    Array.from({ length: colCount }, (_, i) => {
      const cell = i < cells.length ? cells[i]! : "";
      return ` ${cell.padEnd(widths[i]!)} `;
    }).join("│") +
    "│";

  const out = [rule("┌", "┬", "┐", "─"), fmtRow(rows[0]!)];
  if (rows.length > 1) {
    out.push(rule("├", "┼", "┤", "─"));
    for (const row of rows.slice(1)) out.push(fmtRow(row));
  }
  out.push(rule("└", "┴", "┘", "─"));
  return `<pre>${escapeHtml(out.join("\n"))}</pre>`;
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
      let s = escapeHtml(part);
      s = s.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
      s = s.replace(/__(.+?)__/gs, "<b>$1</b>");
      s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
      s = s.replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, "<i>$1</i>");
      parts.push(s);
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
          if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
            return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
          return richToHtml(part);
        })
        .join("");
    })
    .join("\n");
}

function markdownToHtml(text: string): string {
  const result: string[] = [];
  let last = 0;
  const pattern = /```(\w*)\n?(.*?)```|((?:^\|.+\|\s*\n)+)/gms;

  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) result.push(inlineToHtml(text.slice(last, m.index!)));

    if (m[3] !== undefined) {
      result.push(tableToHtml(m[3]));
    } else {
      const lang = (m[1] ?? "").trim();
      const code = escapeHtml((m[2] ?? "").trimEnd());
      result.push(
        lang
          ? `<pre><code class="language-${lang}">${code}</code></pre>`
          : `<pre>${code}</pre>`,
      );
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) result.push(inlineToHtml(text.slice(last)));
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
