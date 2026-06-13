/**
 * Explicit CLI auth exchange proxy for dashboard deployments.
 */

import type { NextRequest } from "next/server";
import { proxyCliRequest } from "../../../../lib/cliProxy";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
    return await proxyCliRequest(req);
}
