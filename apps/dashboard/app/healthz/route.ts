// `build` lets an open tab see that a newer build is being served.
export async function GET(): Promise<Response> {
  return Response.json({ build: process.env.DASHBOARD_BUILD_ID, ok: true });
}
