/**
 * Filesystem tool tests.
 * Cover all S3-backed filesystem operations, shell command parsing, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const ORIGINAL_ENV = { ...process.env };

const s3ObjectExistsMock = mock(async (_bucket: string, _key: string) => false);
const listS3PrefixMock = mock(async (_bucket: string, _prefix: string) => [] as Array<{ key: string }>);
const readS3TextMock = mock(async (_bucket: string, _key: string) => "");
const readS3BytesMock = mock(async (_bucket: string, _key: string) => new Uint8Array());
const writeS3ObjectMock = mock(async (_bucket: string, _key: string, _body: string | Uint8Array, _options?: { contentType?: string }) => 200);
const ensureS3DirectoryMarkersMock = mock(async (_bucket: string, _key: string) => {});
const deleteS3ObjectMock = mock(async (_bucket: string, _key: string) => {});
const deleteS3PrefixMock = mock(async (_bucket: string, _prefix: string) => 0);
const lambdaSendMock = mock(async (_command: unknown) => ({
  Payload: new TextEncoder().encode(JSON.stringify({
    ok: true,
    runtime: "node",
    exitCode: 0,
    stdout: "hello from sandbox\n",
    stderr: "",
    durationMs: 12,
  })),
}));

mock.module("../functions/_shared/s3.ts", () => ({
  s3ObjectExists: s3ObjectExistsMock,
  listS3Prefix: listS3PrefixMock,
  readS3Text: readS3TextMock,
  readS3Bytes: readS3BytesMock,
  writeS3Object: writeS3ObjectMock,
  ensureS3DirectoryMarkers: ensureS3DirectoryMarkersMock,
  deleteS3Object: deleteS3ObjectMock,
  deleteS3Prefix: deleteS3PrefixMock,
}));

mock.module("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = lambdaSendMock;
  },
  InvokeCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

beforeEach(() => {
  process.env.FILESYSTEM_BUCKET_NAME = "test-filesystem-bucket";
  process.env.SANDBOX_NODE_FUNCTION_NAME = "sandbox-node";
  s3ObjectExistsMock.mockClear();
  listS3PrefixMock.mockClear();
  readS3TextMock.mockClear();
  readS3BytesMock.mockClear();
  writeS3ObjectMock.mockClear();
  ensureS3DirectoryMarkersMock.mockClear();
  deleteS3ObjectMock.mockClear();
  deleteS3PrefixMock.mockClear();
  lambdaSendMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function createToolContext(namespace = "test-ns", config: Record<string, unknown> = {}) {
  return {
    conversationKey: "test-conversation",
    filesystemNamespace: namespace,
    config,
    modelProviderName: "google",
    modelProvider: {},
  } as never;
}

async function executeShell(shell: string, namespace = "test-ns", config: Record<string, unknown> = {}) {
  const { default: filesystemTool } = await import("../functions/harness-processing/tools/filesystem.tool.ts");
  const tools = filesystemTool(createToolContext(namespace, config));
  const filesystem = tools.filesystem!;
  return (filesystem as unknown as { execute(input: { shell: string }): Promise<{ type: string; value: any }> }).execute({ shell });
}

describe("filesystem tool", () => {
  describe("pwd command", () => {
    it("returns the visible root path", async () => {
      const result = await executeShell("pwd");
      expect(result).toEqual({ type: "text", value: "/test-ns" });
    });

    it("returns namespace-specific root", async () => {
      const result = await executeShell("pwd", "my-namespace");
      expect(result).toEqual({ type: "text", value: "/my-namespace" });
    });
  });

  describe("ls command", () => {
    it("lists root directory entries", async () => {
      listS3PrefixMock.mockResolvedValue([
        { key: "test-ns/file1.txt" },
        { key: "test-ns/dir1/.keep" },
        { key: "test-ns/dir2/file2.txt" },
      ]);

      const result = await executeShell("ls");
      expect(result.type).toBe("text");
      const lines = (result.value as string).split("\n").sort();
      expect(lines).toEqual(["dir1/", "dir2/", "file1.txt"]);
    });

    it("lists a subdirectory", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([
        { key: "test-ns/subdir/nested.txt" },
      ]);

      const result = await executeShell("ls /subdir");
      expect(result.value).toBe("nested.txt");
    });

    it("returns error for non-existent path", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell("ls /nonexistent");
      expect(result.value).toBe("ls: /test-ns/nonexistent: No such file or directory");
    });

    it("returns filename when path is a file", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("ls /file.txt");
      expect(result.value).toBe("file.txt");
    });

    it("handles ls with flags", async () => {
      listS3PrefixMock.mockResolvedValue([
        { key: "test-ns/file.txt" },
      ]);

      const result = await executeShell("ls -la /");
      expect(result.value).toBe("file.txt");
    });

    it("sorts directories before files", async () => {
      listS3PrefixMock.mockResolvedValue([
        { key: "test-ns/zebra.txt" },
        { key: "test-ns/alpha/.keep" },
        { key: "test-ns/beta/file.txt" },
        { key: "test-ns/alpha2.txt" },
      ]);

      const result = await executeShell("ls");
      const lines = (result.value as string).split("\n");
      expect(lines).toEqual(["alpha/", "alpha2.txt", "beta/", "zebra.txt"]);
    });

    it("filters out dotfiles and hidden directories", async () => {
      listS3PrefixMock.mockResolvedValue([
        { key: "test-ns/.hidden/file.txt" },
        { key: "test-ns/.gitignore" },
        { key: "test-ns/visible.txt" },
      ]);

      const result = await executeShell("ls");
      expect(result.value).toBe("visible.txt");
    });
  });

  describe("cat command", () => {
    it("reads file content", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("hello world");

      const result = await executeShell("cat /file.txt");
      expect(result.value).toBe("hello world");
    });

    it("returns error for non-existent file", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell("cat /missing.txt");
      expect(result.value).toBe("cat: /test-ns/missing.txt: No such file or directory");
    });

    it("returns error when path is a directory", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([{ key: "test-ns/mydir/.keep" }]);

      const result = await executeShell("cat /mydir");
      expect(result.value).toBe("cat: /test-ns/mydir: Is a directory");
    });

    it("handles quoted paths", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("content");

      const result = await executeShell("cat 'file with spaces.txt'");
      expect(result.value).toBe("content");
    });
  });

  describe("sed command", () => {
    it("reads a range of lines", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("line1\nline2\nline3\nline4\nline5");

      const result = await executeShell("sed -n '2,4p' /file.txt");
      expect(result.value).toBe("line2\nline3\nline4");
    });

    it("handles single line range", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("line1\nline2\nline3");

      const result = await executeShell("sed -n '2,2p' /file.txt");
      expect(result.value).toBe("line2");
    });

    it("propagates file-not-found error", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell("sed -n '1,3p' /missing.txt");
      expect(result.value).toBe("cat: /test-ns/missing.txt: No such file or directory");
    });

    it("handles double-quoted sed expression", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("a\nb\nc");

      const result = await executeShell(`sed -n "1,2p" /file.txt`);
      expect(result.value).toBe("a\nb");
    });
  });

  describe("mkdir command", () => {
    it("creates a new directory", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell("mkdir -p /newdir");
      expect(result.value).toBe("Created directory /test-ns/newdir");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/newdir/.keep",
        "",
        { contentType: "text/plain" },
      );
    });

    it("returns success when directory already exists", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([{ key: "test-ns/existing/.keep" }]);

      const result = await executeShell("mkdir -p /existing");
      expect(result.value).toBe("Directory already exists: /test-ns/existing");
    });

    it("returns error when path is a file", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("mkdir -p /file.txt");
      expect(result.value).toBe("Error: /test-ns/file.txt is a file");
    });

    it("handles root directory as already existing", async () => {
      const result = await executeShell("mkdir -p /");
      expect(result.value).toBe("Directory already exists: /test-ns");
    });
  });

  describe("touch command", () => {
    it("creates a new empty file", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell("touch /newfile.txt");
      expect(result.value).toBe("Wrote /test-ns/newfile.txt");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/newfile.txt",
        "",
        { contentType: "text/plain" },
      );
    });

    it("returns touched for existing file", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("touch /existing.txt");
      expect(result.value).toBe("Touched /test-ns/existing.txt");
    });

    it("returns error when path is a directory", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([{ key: "test-ns/mydir/.keep" }]);

      const result = await executeShell("touch /mydir");
      expect(result.value).toBe("Error: /test-ns/mydir is a directory");
    });

    it("returns error when touching root", async () => {
      const result = await executeShell("touch /");
      expect(result.value).toBe("Error: /test-ns is a directory");
    });
  });

  describe("rm command", () => {
    it("deletes a file", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("rm -r /file.txt");
      expect(result.value).toBe("Successfully deleted /test-ns/file.txt");
      expect(deleteS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/file.txt",
      );
    });

    it("deletes a directory and its contents", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([
        { key: "test-ns/mydir/.keep" },
        { key: "test-ns/mydir/file.txt" },
      ]);

      const result = await executeShell("rm -r /mydir");
      expect(result.value).toBe("Successfully deleted /test-ns/mydir");
      expect(deleteS3PrefixMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/mydir/",
      );
    });

    it("returns error for non-existent path", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell("rm -r /missing");
      expect(result.value).toBe("Error: The path /test-ns/missing does not exist");
    });

    it("refuses to delete root", async () => {
      const result = await executeShell("rm -r /");
      expect(result.value).toBe("Error: refusing to delete /test-ns");
    });

    it("handles rm with -f flag", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("rm -f /file.txt");
      expect(result.value).toBe("Successfully deleted /test-ns/file.txt");
    });

    it("handles rm with -rf flag", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("rm -rf /file.txt");
      expect(result.value).toBe("Successfully deleted /test-ns/file.txt");
    });

    it("handles rm without explicit flag", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("rm /file.txt");
      expect(result.value).toBe("Successfully deleted /test-ns/file.txt");
    });
  });

  describe("mv command", () => {
    it("renames a file", async () => {
      s3ObjectExistsMock.mockImplementation(async (_bucket: string, key: string) => {
        return key === "test-ns/old.txt";
      });
      readS3BytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]));

      const result = await executeShell("mv /old.txt /new.txt");
      expect(result.value).toBe("Successfully renamed /test-ns/old.txt to /test-ns/new.txt");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/new.txt",
        expect.any(Uint8Array),
      );
      expect(deleteS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/old.txt",
      );
    });

    it("renames a directory", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockImplementation(async (_bucket: string, prefix: string) => {
        if (prefix.startsWith("test-ns/olddir/")) {
          return [
            { key: "test-ns/olddir/.keep" },
            { key: "test-ns/olddir/file.txt" },
          ];
        }
        return [];
      });
      readS3BytesMock.mockResolvedValue(new Uint8Array());

      const result = await executeShell("mv /olddir /newdir");
      expect(result.value).toBe("Successfully renamed /test-ns/olddir to /test-ns/newdir");
      expect(writeS3ObjectMock).toHaveBeenCalledTimes(2);
      expect(deleteS3ObjectMock).toHaveBeenCalledTimes(2);
    });

    it("returns error when source does not exist", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell("mv /missing.txt /new.txt");
      expect(result.value).toBe("Error: The path /test-ns/missing.txt does not exist");
    });

    it("returns error when destination already exists", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("mv /old.txt /existing.txt");
      expect(result.value).toBe("Error: The destination /test-ns/existing.txt already exists");
    });

    it("returns error when renaming root", async () => {
      const result = await executeShell("mv / /somewhere");
      expect(result.value).toBe("Error: cannot rename /test-ns");
    });

    it("returns error when renaming to root", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("mv /file.txt /");
      expect(result.value).toBe("Error: cannot rename /test-ns");
    });
  });

  describe("heredoc commands", () => {
    it("writes file with leading heredoc syntax", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell(`cat <<'EOF' > /file.txt
hello world
EOF`);
      expect(result.value).toBe("Wrote /test-ns/file.txt");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/file.txt",
        "hello world",
        { contentType: "text/plain" },
      );
      expect(ensureS3DirectoryMarkersMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/file.txt",
      );
    });

    it("appends to file with leading heredoc syntax", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("existing content");

      const result = await executeShell(`cat <<'EOF' >> /file.txt
new content
EOF`);
      expect(result.value).toBe("Wrote /test-ns/file.txt");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/file.txt",
        "existing content\nnew content",
        { contentType: "text/plain" },
      );
    });

    it("writes file with trailing heredoc syntax", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell(`cat > /file.txt <<'EOF'
trailing heredoc
EOF`);
      expect(result.value).toBe("Wrote /test-ns/file.txt");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/file.txt",
        "trailing heredoc",
        { contentType: "text/plain" },
      );
    });

    it("appends to file with trailing heredoc syntax", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("existing");

      const result = await executeShell(`cat >> /file.txt <<'EOF'
appended
EOF`);
      expect(result.value).toBe("Wrote /test-ns/file.txt");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/file.txt",
        "existing\nappended",
        { contentType: "text/plain" },
      );
    });

    it("creates new file when appending to non-existent file", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      const result = await executeShell(`cat <<'EOF' >> /newfile.txt
content
EOF`);
      expect(result.value).toBe("Wrote /test-ns/newfile.txt");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/newfile.txt",
        "content",
        { contentType: "text/plain" },
      );
    });

    it("returns error when writing to directory", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([{ key: "test-ns/mydir/.keep" }]);

      const result = await executeShell(`cat <<'EOF' > /mydir
content
EOF`);
      expect(result.value).toBe("Error: /test-ns/mydir is a directory");
    });

    it("returns error when heredoc path is root", async () => {
      const result = await executeShell(`cat <<'EOF' > /
content
EOF`);
      expect(result.value).toBe("Error: /test-ns is a directory");
    });

    it("handles heredoc write error", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockRejectedValue(new Error("S3 read failed"));

      const result = await executeShell(`cat <<'EOF' >> /file.txt
content
EOF`);
      expect(result.type).toBe("error-text");
      expect(result.value).toBe("S3 read failed");
    });
  });

  describe("unsupported commands", () => {
    it("returns error for unsupported command", async () => {
      const result = await executeShell("echo hello");
      expect(result.type).toBe("error-text");
      expect(result.value).toContain("Unsupported shell command");
      expect(result.value).toContain("pwd");
      expect(result.value).toContain("ls");
      expect(result.value).toContain("cat");
    });

    it("returns error for empty command", async () => {
      const result = await executeShell("   ");
      expect(result.type).toBe("error-text");
      expect(result.value).toBe("Error: shell command is required");
    });
  });

  describe("sandbox execution", () => {
    it("runs an existing JavaScript file through the node sandbox Lambda", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("node /main.js", "test-ns", {
        enabled: true,
        provider: "lambda",
        timeout: 15,
        outputLimitBytes: 4096,
      });

      expect(result.type).toBe("json");
      expect(result.value).toEqual({
        output: {
          stdout: "hello from sandbox\n",
          stderr: "",
          artifacts: [],
        },
        status: {
          ok: true,
          runtime: "node",
          provider: "lambda",
          exitCode: 0,
          durationMs: 12,
          timedOut: false,
          truncated: false,
        },
      });
      expect(readS3TextMock).not.toHaveBeenCalled();
      expect(lambdaSendMock).toHaveBeenCalledTimes(1);
      const command = lambdaSendMock.mock.calls[0]?.[0] as { input: { FunctionName: string; Payload: Uint8Array } };
      expect(command.input.FunctionName).toBe("sandbox-node");
      expect(JSON.parse(new TextDecoder().decode(command.input.Payload))).toMatchObject({
        runtime: "node",
        namespace: "test-ns",
        entryPath: "/main.js",
        args: [],
        workspaceRoot: "/mnt/workspaces",
        timeoutSeconds: 15,
        outputLimitBytes: 4096,
      });
    });

    it("runs an existing Python file through the python sandbox Lambda", async () => {
      process.env.SANDBOX_PYTHON_FUNCTION_NAME = "sandbox-python";
      s3ObjectExistsMock.mockResolvedValue(true);
      lambdaSendMock.mockResolvedValueOnce({
        Payload: new TextEncoder().encode(JSON.stringify({
          ok: true,
          runtime: "python",
          exitCode: 0,
          stdout: "hello\n",
          stderr: "",
          durationMs: 10,
        })),
      });

      const result = await executeShell("python /main.py", "test-ns", {
        enabled: true,
        provider: "lambda",
      });

      expect(result.type).toBe("json");
      expect(result.value).toMatchObject({
        output: {
          stdout: "hello\n",
          stderr: "",
          artifacts: [],
        },
        status: {
          ok: true,
          runtime: "python",
          provider: "lambda",
          exitCode: 0,
        },
      });
      const command = lambdaSendMock.mock.calls[0]?.[0] as { input: { FunctionName: string; Payload: Uint8Array } };
      expect(command.input.FunctionName).toBe("sandbox-python");
      expect(JSON.parse(new TextDecoder().decode(command.input.Payload))).toMatchObject({
        runtime: "python",
        namespace: "test-ns",
        entryPath: "/main.py",
        args: [],
        workspaceRoot: "/mnt/workspaces",
      });
      expect(readS3TextMock).not.toHaveBeenCalled();
    });

    it("persists changed Lambda sandbox file artifacts back to S3", async () => {
      process.env.SANDBOX_PYTHON_FUNCTION_NAME = "sandbox-python";
      s3ObjectExistsMock.mockResolvedValue(true);
      lambdaSendMock.mockResolvedValueOnce({
        Payload: new TextEncoder().encode(JSON.stringify({
          ok: true,
          runtime: "python",
          exitCode: 0,
          stdout: "{\"ok\":true}\n",
          stderr: "",
          durationMs: 11,
          artifacts: [{
            kind: "file",
            path: "/result.json",
            mediaType: "application/json",
            dataBase64: Buffer.from("{\"ok\":true}").toString("base64"),
            metadata: { size: 11 },
          }],
        })),
      });

      const result = await executeShell("python3 /main.py", "test-ns", {
        enabled: true,
        provider: "lambda",
      });

      expect(result.type).toBe("json");
      expect(ensureS3DirectoryMarkersMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/result.json",
      );
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/result.json",
        expect.any(Uint8Array),
        { contentType: "application/json" },
      );
      const body = writeS3ObjectMock.mock.calls.at(-1)?.[2] as Uint8Array;
      expect(new TextDecoder().decode(body)).toBe("{\"ok\":true}");
    });

    it("runs existing TypeScript files through the node sandbox Lambda without reading them first", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);

      const result = await executeShell("node /main.ts --flag", "test-ns", {
        enabled: true,
        provider: "lambda",
      });

      expect(result.type).toBe("json");
      const command = lambdaSendMock.mock.calls[0]?.[0] as { input: { Payload: Uint8Array } };
      const payload = JSON.parse(new TextDecoder().decode(command.input.Payload));
      expect(payload.command).toBeUndefined();
      expect(payload.runtime).toBe("node");
      expect(payload.args).toEqual(["--flag"]);
      expect(payload.entryPath).toBe("/main.ts");
      expect(readS3TextMock).not.toHaveBeenCalled();
      expect(writeS3ObjectMock).not.toHaveBeenCalled();
    });

    it("rejects execution when workspace sandbox is disabled", async () => {
      const result = await executeShell("node /main.js");

      expect(result.type).toBe("error-text");
      expect(result.value).toBe("Error: workspace sandbox execution is disabled");
      expect(lambdaSendMock).not.toHaveBeenCalled();
    });

    it("rejects inline execution flags", async () => {
      const result = await executeShell("node -e \"console.log(1)\"", "test-ns", {
        enabled: true,
      });

      expect(result.type).toBe("error-text");
      expect(result.value).toBe("Execution command must reference one workspace file and cannot use inline flags");
      expect(lambdaSendMock).not.toHaveBeenCalled();
    });

    it("rejects mismatched file extensions", async () => {
      const result = await executeShell("python /main.js", "test-ns", {
        enabled: true,
      });

      expect(result.type).toBe("error-text");
      expect(result.value).toBe("python execution only supports .py files");
      expect(lambdaSendMock).not.toHaveBeenCalled();
    });
  });

  describe("path handling", () => {
    it("handles relative paths", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("content");

      const result = await executeShell("cat subdir/file.txt");
      expect(result.value).toBe("content");
      expect(readS3TextMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/subdir/file.txt",
      );
    });

    it("handles paths with current directory reference", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("content");

      const result = await executeShell("cat ./file.txt");
      expect(result.value).toBe("content");
    });

    it("handles paths with multiple slashes", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("content");

      const result = await executeShell("cat //file.txt");
      expect(result.value).toBe("content");
    });

    it("handles fully-qualified paths with namespace prefix", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("namespaced content");

      const result = await executeShell("cat /test-ns/file.txt");
      expect(result.value).toBe("namespaced content");
    });

    it("handles root namespace path as visible root", async () => {
      const result = await executeShell("ls /test-ns");
      expect(result.type).toBe("text");
    });
  });

  describe("directory traversal prevention", () => {
    it("rejects paths with .. segments", async () => {
      await expect(executeShell("cat ../other/file.txt")).rejects.toThrow(
        "Invalid path: directory traversal not allowed",
      );
    });

    it("rejects paths with encoded traversal", async () => {
      await expect(executeShell("cat %2e%2e/file.txt")).rejects.toThrow(
        "Invalid path: directory traversal not allowed",
      );
    });
  });

  describe("write operations", () => {
    it("prevents writing to root directory", async () => {
      const result = await executeShell(`cat <<'EOF' > /
content
EOF`);
      expect(result.value).toBe("Error: /test-ns is a directory");
    });

    it("prevents writing to existing directory path", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([{ key: "test-ns/mydir/.keep" }]);

      const result = await executeShell(`cat <<'EOF' > /mydir
content
EOF`);
      expect(result.value).toBe("Error: /test-ns/mydir is a directory");
    });

    it("writes file with correct content type", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([]);

      await executeShell(`cat <<'EOF' > /new.txt
hello
EOF`);
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/new.txt",
        "hello",
        { contentType: "text/plain" },
      );
    });
  });

  describe("append operations", () => {
    it("appends to existing file with newline separator", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("first line");

      const result = await executeShell(`cat <<'EOF' >> /file.txt
second line
EOF`);
      expect(result.value).toBe("Wrote /test-ns/file.txt");
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/file.txt",
        "first line\nsecond line",
        { contentType: "text/plain" },
      );
    });

    it("uses just new content when existing file is empty", async () => {
      s3ObjectExistsMock.mockResolvedValue(true);
      readS3TextMock.mockResolvedValue("");

      await executeShell(`cat <<'EOF' >> /file.txt
content
EOF`);
      expect(writeS3ObjectMock).toHaveBeenCalledWith(
        "test-filesystem-bucket",
        "test-ns/file.txt",
        "content",
        { contentType: "text/plain" },
      );
    });

    it("throws error when appending to directory", async () => {
      s3ObjectExistsMock.mockResolvedValue(false);
      listS3PrefixMock.mockResolvedValue([{ key: "test-ns/mydir/.keep" }]);

      const result = await executeShell(`cat <<'EOF' >> /mydir
content
EOF`);
      expect(result.type).toBe("error-text");
      expect(result.value).toBe("/test-ns/mydir is a directory");
    });
  });
});

describe("filesystem tool with different namespaces", () => {
  it("scopes all operations to the correct namespace", async () => {
    s3ObjectExistsMock.mockResolvedValue(true);
    readS3TextMock.mockResolvedValue("namespace content");

    const result = await executeShell("cat /file.txt", "different-ns");
    expect(result.value).toBe("namespace content");
    expect(readS3TextMock).toHaveBeenCalledWith(
      "test-filesystem-bucket",
      "different-ns/file.txt",
    );
  });

  it("returns correct pwd for different namespace", async () => {
    const result = await executeShell("pwd", "another-ns");
    expect(result.value).toBe("/another-ns");
  });
});
