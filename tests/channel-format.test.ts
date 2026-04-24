/**
 * Shared channel formatter tests.
 * Cover exported Slack and Discord formatting behavior directly here.
 */

import { describe, expect, it } from "bun:test";
import {
  formatDiscordMessage,
  formatSlackMessage,
} from "../functions/_shared/channel-format.ts";

describe("channel format helpers", () => {
  it("renders a single markdown table as a Slack attachment and formats surrounding text", () => {
    const formatted = formatSlackMessage(
      "# Heading\n\n- **Bold** item\n\n| Name | Value |\n| --- | --- |\n| **A** | `1` |\n",
    );

    expect(formatted).toEqual({
      text: "*Heading*\n\n• *Bold* item",
      attachments: [{
        blocks: [{
          type: "table",
          column_settings: [{ is_wrapped: true }, null],
          rows: [
            [
              { type: "raw_text", text: "Name" },
              { type: "raw_text", text: "Value" },
            ],
            [
              { type: "raw_text", text: "A" },
              { type: "raw_text", text: "1" },
            ],
          ],
        }],
      }],
    });
  });

  it("falls back to inline monospace tables when multiple markdown tables are present", () => {
    const formatted = formatSlackMessage(
      "Top\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nBottom\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n",
    );

    expect(formatted).toEqual({
      text: "Top\n\n```\nA   | B\n----|----\n1   | 2\n```\n\nBottom\n\n```\nC   | D\n----|----\n3   | 4\n```",
    });
  });

  it("keeps fenced code blocks unchanged while converting markdown tables outside the fence for Discord", () => {
    const formatted = formatDiscordMessage(
      "Before\n\n| Name | Value |\n| --- | --- |\n| **A** | _x_ |\n\n```md\n| keep | code |\n| --- | --- |\n| x | y |\n```\n",
    );

    expect(formatted).toBe(
      "Before\n\n```text\nName | Value\n-----|------\nA    | x    \n```\n\n```md\n| keep | code |\n| --- | --- |\n| x | y |\n```",
    );
  });
});
