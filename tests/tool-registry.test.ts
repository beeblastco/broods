/**
 * Harness tool registry tests.
 * Cover account-configured allowlisting without invoking tool providers.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const tavilySearchMock = mock((options: unknown) => ({ provider: "tavilySearch", options }));
const tavilyExtractMock = mock((options: unknown) => ({ provider: "tavilyExtract", options }));

mock.module("@tavily/ai-sdk", () => ({
  tavilySearch: tavilySearchMock,
  tavilyExtract: tavilyExtractMock,
}));

beforeEach(() => {
  process.env.TAVILY_API_KEY = "tavily-key";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  tavilySearchMock.mockClear();
  tavilyExtractMock.mockClear();
});

describe("createTools", () => {
  it("returns no tools when account config does not list tools", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    expect(createTools(createToolContext(), {})).toEqual({});
    expect(tavilySearchMock).not.toHaveBeenCalled();
    expect(tavilyExtractMock).not.toHaveBeenCalled();
  });

  it("includes only enabled configured tools", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    const tools = createTools(createToolContext(), {
      workspace: {
        enabled: true,
      },
      tools: {
        tavilyExtract: {},
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["filesystem", "tasks", "tavilyExtract"]);
    expect(tavilySearchMock).not.toHaveBeenCalled();
    expect(tavilyExtractMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose workspace tools when workspace is disabled", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    expect(createTools(createToolContext(), {
      workspace: {
        enabled: false,
      },
    })).toEqual({});
  });

  it("passes provider config into Tavily and Google Search tools", async () => {
    const googleSearchMock = mock((options: unknown) => ({ provider: "googleSearch", options }));
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    const tools = createTools(createToolContext(googleSearchMock), {
      tools: {
        tavilySearch: {
          maxResults: 3,
          includeAnswer: false,
        },
        googleSearch: {
          searchTypes: {
            imageSearch: {},
          },
        },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["googleSearch", "tavilySearch"]);
    expect(tavilySearchMock).toHaveBeenCalledWith({
      apiKey: "tavily-key",
      searchDepth: "advanced",
      includeAnswer: false,
      maxResults: 3,
      topic: "general",
    });
    expect(googleSearchMock).toHaveBeenCalledWith({
      searchTypes: {
        imageSearch: {},
      },
    });
  });

  it("rejects googleSearch for non-Google model providers", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    expect(() => createTools(createToolContext(undefined, "openai"), {
      tools: {
        googleSearch: { enabled: true },
      },
    })).toThrow("config.tools.googleSearch requires config.model.provider to be google");
  });

  it("rejects configured tools without a registered factory", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    expect(() => createTools(createToolContext(), {
      tools: {
        filesystem: { enabled: true },
      },
    })).toThrow("config.tools.filesystem is not a supported tool");
  });
});

function createToolContext(
  googleSearch: ((options: unknown) => unknown) | undefined = mock((_options: unknown) => ({ provider: "googleSearch" })),
  modelProviderName = "google",
) {
  return {
    conversationKey: "conversation",
    filesystemNamespace: "filesystem",
    modelProviderName,
    modelProvider: {
      tools: {
        googleSearch,
      },
    },
  } as never;
}
