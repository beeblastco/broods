import type { NextRequest } from "next/server";
import { proxyCliRequest } from "../../../lib/cliProxy";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
    return await proxyCliRequest(req);
}

export async function PUT(req: NextRequest): Promise<Response> {
    return await proxyCliRequest(req);
}

export async function POST(req: NextRequest): Promise<Response> {
    return await proxyCliRequest(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
    return await proxyCliRequest(req);
}
