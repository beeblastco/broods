import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio((): McpServer => {
  const server = new McpServer({ name: "echo", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: "Returns the text it is given.",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({
      text,
    }): Promise<{ content: { type: "text"; text: string }[] }> => ({
      content: [{ type: "text", text: `echo: ${text}` }],
    }),
  );

  return server;
});
