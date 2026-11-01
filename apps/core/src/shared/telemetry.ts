import { logError } from "./log.ts";
import { getStorage } from "./storage.ts";
import type { TaskUsageInput } from "./storage.ts";

export type { TaskUsageInput };

export async function recordTaskUsage(input: TaskUsageInput): Promise<void> {
  try {
    await getStorage().taskUsage.record(input);
  } catch (err) {
    logError("Usage write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
