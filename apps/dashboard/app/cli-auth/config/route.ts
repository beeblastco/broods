// Read by `broods login` before anyone is signed in: where the CLI collects its login.

import { advertisedBaseUrl } from "@/app/lib/serverPage";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return Response.json({ base_url: advertisedBaseUrl() });
  } catch (error) {
    console.error("[cli-auth] no usable BROODS_BASE_URL", error);

    return new Response("this dashboard has no usable BROODS_BASE_URL", {
      status: 500,
    });
  }
}
