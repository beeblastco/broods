interface ApiErrorEnvelope {
  error?: { message?: string; type?: string; code?: string };
}

/** A refusal from a Broods server. Branch on `code`, which stays stable across releases. */
export class BroodsApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly type?: string;
  /** The server's own message, or the raw body when it sent no error envelope. */
  readonly serverMessage: string;
  readonly body: string;

  // The code stays in the text: callers matched it in the raw body the message used to carry.
  constructor(prefix: string, status: number, body: string) {
    const envelope = errorEnvelope(body);
    const serverMessage = envelope.message ?? body;
    super(
      `${prefix} ${serverMessage}${envelope.code ? ` (${envelope.code})` : ""}`,
    );
    this.name = "BroodsApiError";
    this.status = status;
    this.code = envelope.code;
    this.type = envelope.type;
    this.serverMessage = serverMessage;
    this.body = body;
  }
}

export function errorEnvelope(
  body: string,
): NonNullable<ApiErrorEnvelope["error"]> {
  try {
    return (JSON.parse(body) as ApiErrorEnvelope | null)?.error ?? {};
  } catch {
    return {};
  }
}
