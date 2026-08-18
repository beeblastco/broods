/**
 * Reports whether the Next.js server is accepting HTTP requests.
 * @returns JSON health payload for Kubernetes probes
 */
export async function GET(): Promise<Response> {
  return Response.json({ ok: true });
}
