/**
 * Shared channel streaming driver.
 * Turns the agent's streamed output into incremental channel updates so a chat
 * reply appears live instead of only after the whole turn. Three modes:
 *  - "edit": post one placeholder message, then edit it in place on a throttled
 *    cadence (needs the channel's beginMessage/editMessage primitives); when the
 *    reply outgrows the channel's message-length cap the current message is frozen
 *    and streaming continues in a fresh one (rotation).
 *  - "progress": one live preview for the whole turn (openclaw's progress draft).
 *    While the model works it shows a compact status (💭 reasoning + 🛠 tool lines);
 *    when the answer starts streaming the text takes over the same message; finish()
 *    finalizes that one message in place. One message per turn — never per-block.
 *  - "chunk": send a new message as each paragraph completes (uses sendText, so it
 *    works for every channel).
 * Accumulation + throttling live here so each channel adapter stays thin; a channel
 * that cannot edit a posted message falls back to "chunk" for edit/progress modes.
 */

import type { ChannelActions } from "./channels.ts";

export type ChannelStreamMode = "edit" | "chunk" | "progress";

// Telegram/Slack/Discord all rate-limit edits; ~1.2s coalesces bursty token
// deltas into a calm cadence well under every provider's edit ceiling. Matches
// openclaw's per-channel draft-stream throttle (1000ms Telegram / 1200ms Discord).
const DEFAULT_EDIT_THROTTLE_MS = 1200;

// Rotate a streamed edit message before it hits the provider cap. Telegram renders
// a message at ~4096 chars; we rotate on the raw markdown well under that since
// markdown expands to HTML (e.g. **x** -> <b>x</b>). A channel can override via
// ChannelActions.editMaxChars (e.g. Discord's 2000 limit).
const DEFAULT_EDIT_MAX_CHARS = 3500;

// Keep the progress preview short (newest tool lines win), like openclaw's status
// draft (maxLines 8).
const PROGRESS_MAX_LINES = 8;
const PROGRESS_HEADER = "⏳ Working…";
// The reasoning preview is a single replaceable line (openclaw keeps it compact
// instead of appending noise). Show the most recent slice of the live thought.
const PROGRESS_REASONING_MAX_CHARS = 200;

export interface ChannelStreamWriter {
  // Feed the next assistant text delta. Flushes to the channel on its own cadence.
  push(delta: string): Promise<void>;
  // Feed a tool-activity label (progress mode only; no-op otherwise). Present only
  // on writers that render a status preview.
  progress?(label: string): Promise<void>;
  // Feed the next reasoning/thinking delta (progress mode only; no-op otherwise).
  // Rendered as one compact, replaceable line so the live thought stays visible
  // without flooding the preview.
  reasoning?(delta: string): Promise<void>;
  // Flush text completed by the current model step. Chunk mode sends one
  // message per completed step even when the model did not emit a paragraph.
  stepFinish?(): Promise<void>;
  // Final flush. Pass the authoritative final text so the last message matches the
  // model's final response exactly even if deltas were coalesced.
  finish(finalText?: string): Promise<void>;
}

export function createChannelStreamWriter(
  actions: ChannelActions,
  mode: ChannelStreamMode,
  throttleMs: number = DEFAULT_EDIT_THROTTLE_MS,
  maxChars?: number,
): ChannelStreamWriter {
  const limit = maxChars ?? actions.editMaxChars ?? DEFAULT_EDIT_MAX_CHARS;
  const canEdit =
    typeof actions.beginMessage === "function" &&
    typeof actions.editMessage === "function";
  if (mode === "progress" && canEdit) return progressWriter(actions, throttleMs, limit);
  if (mode === "edit" && canEdit) return editWriter(actions, throttleMs, limit);
  return chunkWriter(actions);
}

// Keeps one channel message in sync with a desired full text, throttled, rotating
// into a new message past maxChars. Shared by the "edit" (assistant text) and
// "progress" (status + answer) writers so the rotation logic lives in one place.
function messageEditor(actions: ChannelActions, throttleMs: number, maxChars: number) {
  let accumulated = "";
  let committed = 0; // chars already frozen into earlier (rotated) messages
  let messageId: string | undefined;
  let lastSent = "";
  let lastFlushAt = 0;

  const post = async (text: string): Promise<void> => {
    if (messageId === undefined) {
      messageId = await actions.beginMessage!(text);
    } else {
      await actions.editMessage!(messageId, text);
    }
    lastSent = text;
  };

  // Largest prefix of `segment` (<= maxChars) to freeze before rotating, preferring
  // a paragraph/line/space break in the back half so we never cut mid-word; hard
  // cut at maxChars when no break is near. Returns the raw index (incl. the break).
  const splitAt = (segment: string): number => {
    const limit = Math.min(maxChars, segment.length);
    for (const brk of ["\n\n", "\n", " "]) {
      const i = segment.lastIndexOf(brk, limit);
      if (i >= maxChars * 0.5) return i + brk.length;
    }
    return limit;
  };

  const flush = async (): Promise<void> => {
    let segment = accumulated.slice(committed);
    // Rotate: freeze the current message at a break and open a fresh one while the
    // live segment is still over the cap.
    while (segment.length > maxChars) {
      const cut = splitAt(segment);
      const head = segment.slice(0, cut).trimEnd();
      // Skip a redundant edit when the message already shows exactly this head.
      if (head && head !== lastSent) await post(head);
      committed += cut;
      messageId = undefined; // the next post opens a new message
      lastSent = "";
      segment = accumulated.slice(committed);
    }
    const text = segment.trim();
    if (!text || text === lastSent) return;
    await post(text);
    lastFlushAt = Date.now();
  };

  return {
    // Set the desired full message content; flushes once per throttle window.
    update: async (fullText: string): Promise<void> => {
      accumulated = fullText;
      if (committed > accumulated.length) committed = 0; // content shrank (e.g. status -> answer)
      if (Date.now() - lastFlushAt >= throttleMs) await flush();
    },
    // Set the authoritative final content and flush it unconditionally.
    finalize: async (fullText?: string): Promise<void> => {
      if (fullText !== undefined) {
        accumulated = fullText;
        if (committed > accumulated.length) committed = 0;
      }
      await flush();
    },
  };
}

// Edit one message in place as the assistant text streams. finish() guarantees the
// authoritative final text is applied even if deltas were coalesced.
function editWriter(actions: ChannelActions, throttleMs: number, maxChars: number): ChannelStreamWriter {
  const editor = messageEditor(actions, throttleMs, maxChars);
  let text = "";
  return {
    push: async (delta) => {
      text += delta;
      await editor.update(text);
    },
    finish: async (finalText) => {
      await editor.finalize(finalText);
    },
  };
}

// One live preview for the whole turn (openclaw's progress draft). While the model
// works the preview is a compact status — "⏳ Working…" + a single replaceable 💭
// reasoning line + the most recent 🛠 tool lines. As soon as the answer starts
// streaming, the text takes over the same message (so it never stays "stuck" in the
// status). finish() finalizes that one message in place with the authoritative final
// text. A new tool call after some text drops back to the status view for the next
// step. One message per turn — no per-block spam.
function progressWriter(actions: ChannelActions, throttleMs: number, maxChars: number): ChannelStreamWriter {
  const editor = messageEditor(actions, throttleMs, maxChars);
  let answer = "";
  let reasoning = "";
  const tools: string[] = [];
  let showingAnswer = false; // once the answer streams it owns the preview
  let reasoningStale = false; // the next reasoning delta starts a new step's thought

  // Collapse the live thought to one compact, replaceable line (newest slice wins).
  const compactReasoning = (): string => {
    const text = reasoning.replace(/\s+/g, " ").trim();

    return text.length > PROGRESS_REASONING_MAX_CHARS ? `…${text.slice(-PROGRESS_REASONING_MAX_CHARS)}` : text;
  };

  const statusView = (): string => {
    const lines = [PROGRESS_HEADER];
    if (reasoning.trim()) lines.push(`💭 ${compactReasoning()}`);
    lines.push(...tools.slice(-PROGRESS_MAX_LINES));

    return lines.join("\n");
  };

  return {
    push: async (delta) => {
      answer += delta;
      showingAnswer = true;
      await editor.update(answer.trim());
    },
    reasoning: async (delta) => {
      if (showingAnswer) return; // the answer owns the preview once it starts
      if (reasoningStale) { reasoning = ""; reasoningStale = false; } // new step's thought
      reasoning += delta;
      await editor.update(statusView());
    },
    progress: async (label) => {
      // A tool call ends the step: keep this step's reasoning beside the tool, but
      // drop any narration text and let the next step's reasoning replace this one.
      showingAnswer = false;
      answer = "";
      reasoningStale = true;
      tools.push(`• ${label}`);
      await editor.update(statusView());
    },
    finish: async (finalText) => {
      const final = typeof finalText === "string" && finalText.trim()
        ? finalText
        : (answer.trim() || (tools.length ? statusView() : undefined));
      await editor.finalize(final);
    },
  };
}

// Append-only: send each completed paragraph (blank-line boundary) as its own
// message; finish() sends whatever is left. No edit primitive required. Paragraph
// boundaries inside a ``` code fence are skipped so a fenced block is never split.
function chunkWriter(actions: ChannelActions): ChannelStreamWriter {
  let buffer = "";

  const flush = async (): Promise<void> => {
    const remainder = buffer.trim();
    buffer = "";
    if (remainder) await actions.sendText(remainder);
  };

  return {
    push: async (delta) => {
      buffer += delta;
      let boundary: number;
      while ((boundary = paragraphBoundary(buffer)) !== -1) {
        const paragraph = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (paragraph) await actions.sendText(paragraph);
      }
    },
    stepFinish: flush,
    finish: flush,
  };
}

// First blank-line boundary that is not inside an open ``` code fence, so a fenced
// block (which can contain blank lines) is kept whole until it closes. Returns -1
// when every boundary so far sits inside an unclosed fence.
function paragraphBoundary(text: string): number {
  let from = 0;
  while (true) {
    const idx = text.indexOf("\n\n", from);
    if (idx === -1) return -1;
    const fences = text.slice(0, idx).split("```").length - 1;
    if (fences % 2 === 0) return idx; // even => outside any open fence
    from = idx + 2;
  }
}
