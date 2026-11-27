import { clientErrorData } from "@broods/convex/model/clientError";

export function toErrorMessage(error: unknown): string {
  const clientError = clientErrorData(error);
  if (clientError) return clientError.message;

  return error instanceof Error ? error.message : String(error);
}
