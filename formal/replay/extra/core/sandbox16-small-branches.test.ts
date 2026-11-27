import { afterEach, describe, expect, test } from "bun:test";

import {
  disallowedRuntimeCommand,
  editNeedsApproval,
  workspaceMediaUrl,
} from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import { fileOperationScript } from "../../../../apps/core/src/harness/tools/file-operation.ts";
import { parseCoreFrame } from "../../../../apps/core/src/shared/machine-socket.ts";
import type { ResolvedWorkspace } from "../../../../apps/core/src/shared/workspaces.ts";

const WORKSPACE: ResolvedWorkspace = {
  name: "notes",
  workspaceId: "ws_1",
  namespace: "fs-1",
  config: { storage: { provider: "s3" } },
  sandbox: { provider: "lambda", permissionMode: "ask" },
};
const savedBaseUrl = process.env.PUBLIC_BASE_URL;

afterEach((): void => {
  if (savedBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = savedBaseUrl;
});

describe("editNeedsApproval", (): void => {
  test("an unknown workspace name needs approval", (): void => {
    expect(editNeedsApproval([WORKSPACE], "missing")).toBe(true);
  });
});

describe("disallowedRuntimeCommand", (): void => {
  test("a sandbox without bash refuses every command", (): void => {
    expect(
      disallowedRuntimeCommand(
        { provider: "lambda", runtimes: ["python"] },
        "ls",
      ),
    ).toBe("Error: this sandbox does not allow bash commands");
  });

  test("a sandbox without python refuses python", (): void => {
    expect(
      disallowedRuntimeCommand(
        { provider: "lambda", runtimes: ["bash", "node"] },
        "python3 x.py",
      ),
    ).toBe("Error: this sandbox does not allow python commands");
  });
});

describe("workspaceMediaUrl", (): void => {
  test("a file link needs the public base URL", async (): Promise<void> => {
    delete process.env.PUBLIC_BASE_URL;

    await expect(
      workspaceMediaUrl(WORKSPACE, "a.png", "acct_1"),
    ).rejects.toThrow(
      "sending a workspace file needs PUBLIC_BASE_URL configured",
    );
  });
});

describe("fileOperationScript", (): void => {
  test("the workspace root is not a file", (): void => {
    expect((): string =>
      fileOperationScript({ type: "insert", path: "/", line: 0, text: "x" }),
    ).toThrow("path must reference a file");
  });
});

describe("parseFrame", (): void => {
  test("a frame that is not text is dropped", (): void => {
    expect(parseCoreFrame(42)).toBeNull();
  });
});
