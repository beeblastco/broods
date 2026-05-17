/**
 * Tasks tool tests.
 * Cover task create, list, update, and error paths without hitting S3.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as actualAi from "ai";

const readS3TextMock = mock(async (_bucket: string, _key: string) => "");
const writeS3ObjectMock = mock(async (_bucket: string, _key: string, _body: string, _options?: { contentType?: string }) => 200);
const listS3PrefixMock = mock(async (_bucket: string, _prefix: string) => [] as { key: string }[]);
const deleteS3ObjectMock = mock(async (_bucket: string, _key: string) => {});

mock.module("../functions/_shared/s3.ts", () => ({
  readS3Text: readS3TextMock,
  writeS3Object: writeS3ObjectMock,
  listS3Prefix: listS3PrefixMock,
  deleteS3Object: deleteS3ObjectMock,
  s3ObjectExists: mock(async () => false),
  deleteS3Prefix: mock(async () => 0),
  isMissingS3Error: mock(() => false),
}));

mock.module("ai", () => ({
  ...actualAi,
}));

beforeEach(() => {
  process.env.FILESYSTEM_BUCKET_NAME = "test-bucket";
  readS3TextMock.mockReset();
  writeS3ObjectMock.mockReset();
  listS3PrefixMock.mockReset();
  deleteS3ObjectMock.mockReset();
  listS3PrefixMock.mockImplementation(async () => []);
  readS3TextMock.mockImplementation(async () => "");
  writeS3ObjectMock.mockImplementation(async () => 200);
});

describe("tasks tool", () => {
  it("exposes a tasks tool with the correct description", async () => {
    const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
    const tools = tasksTool(createToolContext());

    expect(tools.tasks).toBeDefined();
    expect(tools.tasks?.description).toBe("Create, list, and update task lists by title.");
  });

  describe("create command", () => {
    it("creates a new task list with tasks", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "create",
        title: "Sprint Tasks",
        tasks: ["Design UI", "Write tests"],
      });

      expect(result).toEqual({
        type: "text",
        value: expect.stringContaining("Created task list \"Sprint Tasks\""),
      });
      expect(writeS3ObjectMock).toHaveBeenCalledTimes(1);
      const writeCall = writeS3ObjectMock.mock.calls[0]!;
      expect(writeCall[0]).toBe("test-bucket");
      expect(writeCall[1]).toMatch(/^test-ns\/tasks-[a-z0-9]{8}\.md$/);
      expect(writeCall[2]).toContain("# Sprint Tasks");
      expect(writeCall[2]).toContain("- [ ] Design UI");
      expect(writeCall[2]).toContain("- [ ] Write tests");
      expect(writeCall[3]).toEqual({ contentType: "text/markdown" });
    });

    it("returns an error when title is missing", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "create",
        tasks: ["Do something"],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: title is required for create",
      });
    });

    it("returns an error when title is empty string", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "create",
        title: "   ",
        tasks: ["Do something"],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: title is required for create",
      });
    });

    it("returns an error when tasks array is empty", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "create",
        title: "My List",
        tasks: [],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: tasks must include at least one task item",
      });
    });

    it("returns an error when tasks contains only whitespace", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "create",
        title: "My List",
        tasks: ["   ", "  "],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: tasks must include at least one task item",
      });
    });

    it("returns an error when a task list with the same title already exists", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Sprint Tasks\n\n- [ ] Old task");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "create",
        title: "Sprint Tasks",
        tasks: ["New task"],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: a task list named \"Sprint Tasks\" already exists",
      });
      expect(writeS3ObjectMock).not.toHaveBeenCalled();
    });

    it("trims whitespace from title and task names", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      await execute({
        command: "create",
        title: "  My Tasks  ",
        tasks: ["  Task A  ", "  Task B  "],
      });

      const writeCall = writeS3ObjectMock.mock.calls[0]!;
      expect(writeCall[2]).toContain("# My Tasks");
      expect(writeCall[2]).toContain("- [ ] Task A");
      expect(writeCall[2]).toContain("- [ ] Task B");
    });
  });

  describe("list command", () => {
    it("returns 'No task lists found' when there are no task lists", async () => {
      listS3PrefixMock.mockImplementation(async () => []);

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({ command: "list" });

      expect(result).toEqual({
        type: "text",
        value: "No task lists found",
      });
    });

    it("lists all task lists sorted by title", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-zzzzzzzz.md" },
        { key: "test-ns/tasks-aaaaaaaa.md" },
      ]);
      readS3TextMock.mockImplementation(async (_bucket, key) => {
        if (key.includes("aaaaaaaa")) {
          return "# Alpha Tasks\n\n- [ ] Task 1\n- [x] Task 2";
        }
        return "# Zebra Tasks\n\n- [ ] Task A";
      });

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({ command: "list" });

      expect(result).toEqual({
        type: "text",
        value: expect.stringContaining("Alpha Tasks"),
      });
      const value = (result as { value: string }).value;
      const alphaIndex = value.indexOf("Alpha Tasks");
      const zebraIndex = value.indexOf("Zebra Tasks");
      expect(alphaIndex).toBeLessThan(zebraIndex);
      expect(value).toContain("- [ ] Task 1");
      expect(value).toContain("- [x] Task 2");
      expect(value).toContain("- [ ] Task A");
    });

    it("filters out keys that do not match the task key pattern", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
        { key: "test-ns/other-file.md" },
        { key: "test-ns/tasks-short.md" },
        { key: "other-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Valid\n\n- [ ] Item");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({ command: "list" });

      expect(result).toEqual({
        type: "text",
        value: expect.stringContaining("Valid"),
      });
      expect(readS3TextMock).toHaveBeenCalledTimes(1);
    });

    it("renders empty task list message when a document has no tasks", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Empty List\n\n");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({ command: "list" });

      expect(result).toEqual({
        type: "text",
        value: "Empty List\n(empty task list)",
      });
    });
  });

  describe("update command", () => {
    it("marks tasks as done and returns updated list", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Sprint Tasks\n\n- [ ] Design UI\n- [ ] Write tests\n- [ ] Deploy");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        title: "Sprint Tasks",
        done: ["Design UI"],
      });

      expect(result).toEqual({
        type: "text",
        value: expect.stringContaining("Updated task list \"Sprint Tasks\""),
      });
      const value = (result as { value: string }).value;
      expect(value).toContain("- [x] Design UI");
      expect(value).toContain("- [ ] Write tests");
      expect(value).toContain("- [ ] Deploy");
      expect(writeS3ObjectMock).toHaveBeenCalledTimes(1);
    });

    it("preserves already-checked tasks", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Sprint Tasks\n\n- [x] Design UI\n- [ ] Write tests\n- [ ] Deploy");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        title: "Sprint Tasks",
        done: ["Write tests"],
      });

      const value = (result as { value: string }).value;
      expect(value).toContain("- [x] Design UI");
      expect(value).toContain("- [x] Write tests");
      expect(value).toContain("- [ ] Deploy");
    });

    it("removes the task list when all tasks are done", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Sprint Tasks\n\n- [x] Design UI\n- [ ] Write tests");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        title: "Sprint Tasks",
        done: ["Write tests"],
      });

      expect(result).toEqual({
        type: "text",
        value: "All tasks in \"Sprint Tasks\" are done. Removed the task list.",
      });
      expect(deleteS3ObjectMock).toHaveBeenCalledWith("test-bucket", "test-ns/tasks-abc12345.md");
      expect(writeS3ObjectMock).not.toHaveBeenCalled();
    });

    it("returns an error when title is missing", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        done: ["Task A"],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: title is required for update",
      });
    });

    it("returns an error when title is whitespace only", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        title: "   ",
        done: ["Task A"],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: title is required for update",
      });
    });

    it("returns an error when done array is empty", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        title: "Sprint Tasks",
        done: [],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: done must include at least one task name",
      });
    });

    it("returns an error when done contains only whitespace", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        title: "Sprint Tasks",
        done: ["  ", "   "],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: done must include at least one task name",
      });
    });

    it("returns an error when task list is not found", async () => {
      listS3PrefixMock.mockImplementation(async () => []);

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        title: "Nonexistent List",
        done: ["Task A"],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: task list \"Nonexistent List\" was not found",
      });
    });

    it("returns an error when a task name is not found in the list", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Sprint Tasks\n\n- [ ] Design UI\n- [ ] Write tests");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "update",
        title: "Sprint Tasks",
        done: ["Nonexistent Task"],
      });

      expect(result).toEqual({
        type: "text",
        value: "Error: task \"Nonexistent Task\" was not found in \"Sprint Tasks\"",
      });
      expect(writeS3ObjectMock).not.toHaveBeenCalled();
    });

    it("trims whitespace from title and done task names", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Sprint Tasks\n\n- [ ] Design UI\n- [ ] Write tests");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      await execute({
        command: "update",
        title: "  Sprint Tasks  ",
        done: ["  Design UI  "],
      });

      expect(writeS3ObjectMock).toHaveBeenCalledTimes(1);
      const writeCall = writeS3ObjectMock.mock.calls[0]!;
      expect(writeCall[2]).toContain("- [x] Design UI");
      expect(writeCall[2]).toContain("- [ ] Write tests");
    });
  });

  describe("error handling", () => {
    it("catches and returns S3 read errors as error-text", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => {
        throw new Error("S3 connection failed");
      });

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({ command: "list" });

      expect(result).toEqual({
        type: "error-text",
        value: "S3 connection failed",
      });
    });

    it("catches and returns S3 write errors as error-text", async () => {
      listS3PrefixMock.mockImplementation(async () => []);
      writeS3ObjectMock.mockImplementation(async () => {
        throw new Error("S3 write failed");
      });

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "create",
        title: "My List",
        tasks: ["Task A"],
      });

      expect(result).toEqual({
        type: "error-text",
        value: "S3 write failed",
      });
    });

    it("handles non-Error exceptions as error-text", async () => {
      listS3PrefixMock.mockImplementation(async () => {
        throw "string error";
      });

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({ command: "list" });

      expect(result).toEqual({
        type: "error-text",
        value: "string error",
      });
    });

    it("returns error-text for unsupported command", async () => {
      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({
        command: "delete",
      });

      expect(result).toEqual({
        type: "error-text",
        value: "Error: unsupported task command",
      });
    });
  });

  describe("task document parsing", () => {
    it("parses mixed checked and unchecked tasks with x and X", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "# Mixed Tasks\n\n- [ ] unchecked\n- [x] lowercase x\n- [X] uppercase X");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({ command: "list" });

      const value = (result as { value: string }).value;
      expect(value).toContain("- [ ] unchecked");
      expect(value).toContain("- [x] lowercase x");
      expect(value).toContain("- [x] uppercase X");
    });

    it("throws when a task document is missing a title", async () => {
      listS3PrefixMock.mockImplementation(async () => [
        { key: "test-ns/tasks-abc12345.md" },
      ]);
      readS3TextMock.mockImplementation(async () => "- [ ] No title here");

      const { default: tasksTool } = await import("../functions/harness-processing/tools/tasks.tool.ts");
      const tools = tasksTool(createToolContext());
      const execute = getExecute(tools);

      const result = await execute({ command: "list" });

      expect(result).toEqual({
        type: "error-text",
        value: "Task list is missing a title: tasks-abc12345.md",
      });
    });
  });
});

function createToolContext() {
  return {
    conversationKey: "test-conversation",
    filesystemNamespace: "test-ns",
    config: {},
    modelProviderName: "google",
    modelProvider: {},
  } as never;
}

function getExecute(tools: Record<string, unknown>) {
  return (tools.tasks as unknown as { execute(input: unknown): Promise<unknown> }).execute;
}
