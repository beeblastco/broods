# Cloudflare Browser Run

[Kitesurf](https://blog.cloudflare.com/kitesurf/) is Cloudflare's lightweight browser for agents, served by Browser Run. Broods has no built-in browser tool. Give an agent one through an [MCP server](tools.md#mcp-servers). The simplest is a hosted server that calls Browser Run's quick actions.

## Hosted MCP server on Kitesurf

Install the MCP server SDK and zod in your project:

```bash
bun add @modelcontextprotocol/server zod
```

Store your Cloudflare account ID and an API token with the **Browser Rendering - Edit** permission:

```bash
broods env set CLOUDFLARE_ACCOUNT_ID <account-id>
broods env set CLOUDFLARE_API_TOKEN <api-token>
```

Define the server and attach it to an agent:

```ts title="broods/index.ts"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { defineAgent, defineMcp } from "broods";
import { z } from "zod";

const BROWSER_RUN_URL = "https://api.cloudflare.com/client/v4/accounts";
const MARKDOWN_RESPONSE = z.object({ result: z.string() });

export const browser = defineMcp({
  name: "browser",
  description: "Cloudflare Browser Run on Kitesurf.",
  handler: createMcpHandler(({ requestInfo }) => {
    const server = new McpServer({ name: "kitesurf", version: "1.0.0" });
    server.registerTool(
      "markdown",
      {
        description: "Open a URL and return the page as Markdown.",
        inputSchema: z.object({ url: z.url() }),
      },
      async ({ url }) => {
        const response = await quickAction(requestInfo, "markdown", {
          url: url,
        });
        const { result } = MARKDOWN_RESPONSE.parse(await response.json());

        return { content: [{ type: "text", text: result }] };
      },
    );
    server.registerTool(
      "screenshot",
      {
        description: "Open a URL and return a PNG screenshot.",
        inputSchema: z.object({
          url: z.url(),
          fullPage: z.boolean().optional(),
        }),
      },
      async ({ url, fullPage }) => {
        const response = await quickAction(requestInfo, "screenshot", {
          url: url,
          screenshotOptions: { fullPage: fullPage ?? false },
        });
        const bytes = Buffer.from(await response.arrayBuffer());

        return {
          content: [
            {
              type: "image",
              data: bytes.toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      },
    );

    return server;
  }),
});

export const researcher = defineAgent({
  name: "researcher",
  agent: { system: "Use the browser tools to read web pages." },
  mcp: {
    [browser.name]: {
      enabled: true,
      // Set on the agent entry so the ${NAME} refs resolve at sync.
      headers: {
        Authorization: "Bearer ${CLOUDFLARE_API_TOKEN}",
        "X-Cloudflare-Account-Id": "${CLOUDFLARE_ACCOUNT_ID}",
      },
    },
  },
});

// Calls one Browser Run quick action on Kitesurf with the headers the agent sent.
async function quickAction(
  request: Request | undefined,
  action: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const accountId = request?.headers.get("x-cloudflare-account-id");
  const authorization = request?.headers.get("authorization");
  if (!accountId || !authorization) {
    throw new Error("missing Cloudflare account ID or token header");
  }
  const response = await fetch(
    `${BROWSER_RUN_URL}/${accountId}/browser-run/${action}?browser=kitesurf`,
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Browser Run ${action} failed: ${response.status} ${await response.text()}`,
    );
  }

  return response;
}
```

Run `broods deploy`. The agent gets `browser__markdown` and `browser__screenshot`. Add other quick actions the same way:

| Quick action | Request body                 | Response                   |
| ------------ | ---------------------------- | -------------------------- |
| `markdown`   | `{ url }` or `{ html }`      | `{ success, result }` JSON |
| `content`    | `{ url }`                    | `{ success, result }` HTML |
| `links`      | `{ url }`                    | `{ success, result }` URLs |
| `screenshot` | `{ url, screenshotOptions }` | PNG bytes                  |
| `pdf`        | `{ url }`                    | PDF bytes                  |

Gotchas:

- Secrets reach a hosted server only as request headers. It has no `process.env`.
- Calls from one model step share a 30 second deadline and 16 MB of output. A full-page screenshot of a long page can hit either.
- Drop `?browser=kitesurf` to run the same actions on Browser Run's default Chromium.

## Other routes

| Route                    | Setup                                                                                                                                                      | Gives you                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Cloudflare's MCP server  | `defineMcp` with `url: "https://browser.mcp.cloudflare.com/mcp"`, and `Authorization: "Bearer ${CLOUDFLARE_API_TOKEN}"` in the agent's `mcp` entry headers | Markdown and screenshots, no Kitesurf flag |
| Full CDP on your machine | `chrome-devtools-mcp` pointed at the Kitesurf DevTools WebSocket, run through a [machine sandbox](sandboxes/machine.md)                                    | Clicks, typing, multi-step sessions        |

:::note Unverified

- Cloudflare's MCP server: stateless transport support not confirmed.
- Hosted MCP server: egress to `api.cloudflare.com` not tested.

:::
