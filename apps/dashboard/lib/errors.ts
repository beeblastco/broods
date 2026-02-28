/** Normalize unknown thrown values to a readable error message. */
export function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
