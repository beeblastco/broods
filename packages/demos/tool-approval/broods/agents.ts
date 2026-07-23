import { google } from "@ai-sdk/google";
import { defineAgent, env } from "broods";

export const approvalAgent = defineAgent({
  name: "approval-agent",
  config: {
    provider: {
      google: { apiKey: env.GOOGLE_API_KEY },
    },
    model: {
      provider: "google",
      modelId: "gemma-4-31b-it",
    },
    agent: {
      system: "Use web search when current web information is needed.",
    },
    tools: {
      // Import the tool from the AI SDK provider and pass it straight in. It
      // serializes to a provider-defined descriptor; core rebuilds it off the
      // configured google provider. `needsApproval` is a Broods-side flag.
      googleSearch: {
        ...google.tools.googleSearch({}),
        needsApproval: true,
      },
    },
    publicAccess: true,
  },
});
