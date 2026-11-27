// Read by `broods login` before anyone is signed in: where the CLI collects its login.

import { toErrorMessage } from "@/app/lib/errors";
import { advertisedBaseUrl } from "@/app/lib/serverPage";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return Response.json({ base_url: advertisedBaseUrl() });
  } catch (error) {
    return new Response(toErrorMessage(error), { status: 500 });
  }
}
