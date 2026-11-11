import { describe, expect, it } from "bun:test";
import type { IngressAdmission } from "../src/harness/ingress.ts";
import type { DirectInboundEvent } from "../src/harness/integrations.ts";
import { directAdmissionResponse } from "../src/harness/responses.ts";

const REFUSALS: IngressAdmission[] = [
  { outcome: "rejected" },
  { outcome: "capacity" },
  { outcome: "conflict" },
];

describe("admission refusals", () => {
  it("carry the same code and type in the SSE error frame as in the JSON envelope", async (): Promise<void> => {
    const event = {} as DirectInboundEvent;
    for (const admission of REFUSALS) {
      const json = directAdmissionResponse(event, admission, true);
      const sse = directAdmissionResponse(event, admission, false);
      const { error } = (await json.json()) as {
        error: { message: string; type: string; code: string };
      };
      const frame: unknown = JSON.parse(
        (await sse.text()).replace(/^data: /, ""),
      );

      expect(sse.status).toBe(json.status);
      expect(sse.headers.get("content-type")).toBe("text/event-stream");
      expect(sse.headers.get("retry-after")).toBe(
        json.headers.get("retry-after"),
      );
      expect(frame).toEqual({
        type: "error",
        error: error.message,
        code: error.code,
        errorType: error.type,
      });
    }
  });
});
