import { clientErrorData } from "@broods/convex/model/clientError";

/** A Convex client error's own sentence, else the error's message. */
export function toErrorMessage(error: unknown): string {
  const clientError = clientErrorData(error);
  if (clientError) return clientError.message;

  return error instanceof Error ? error.message : String(error);
}
