import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ToolError, createToolRegistry } from "./tools.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), "synthia-tools-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("tool registry", () => {
  it("registers the agent tools and returns deterministic current time", async () => {
    const registry = createToolRegistry({
      workspaceRoot: createWorkspace(),
      now: () => new Date("2026-07-30T12:34:56.000Z"),
    });

    expect(registry.definitions.map((tool) => tool.name)).toEqual([
      "current_time",
      "list_files",
      "read_file",
      "write_file",
      "remember",
    ]);
    await expect(registry.execute("current_time", {})).resolves.toEqual({
      iso: "2026-07-30T12:34:56.000Z",
    });
  });

  it("validates every argument object on the server", async () => {
    const registry = createToolRegistry({ workspaceRoot: createWorkspace() });

    await expect(
      registry.execute("current_time", { unexpected: true }),
    ).rejects.toMatchObject<Partial<ToolError>>({
      code: "TOOL_ARGUMENTS_INVALID",
    });
    await expect(
      registry.execute("read_file", { path: 42 }),
    ).rejects.toMatchObject<Partial<ToolError>>({
      code: "TOOL_ARGUMENTS_INVALID",
    });
    await expect(
      registry.execute("missing_tool", {}),
    ).rejects.toMatchObject<Partial<ToolError>>({
      code: "TOOL_NOT_FOUND",
    });
  });

  it("lists, writes, and reads files while confining paths to the workspace", async () => {
    const workspaceRoot = createWorkspace();
    const registry = createToolRegistry({ workspaceRoot });

    await expect(
      registry.execute("write_file", {
        path: "notes/agent.txt",
        content: "Tool loop works.",
      }),
    ).resolves.toEqual({
      path: "notes/agent.txt",
      bytesWritten: 16,
    });
    expect(readFileSync(join(workspaceRoot, "notes", "agent.txt"), "utf8")).toBe(
      "Tool loop works.",
    );
    await expect(
      registry.execute("read_file", { path: "notes/agent.txt" }),
    ).resolves.toEqual({
      path: "notes/agent.txt",
      content: "Tool loop works.",
    });
    await expect(
      registry.execute("list_files", { path: "notes" }),
    ).resolves.toEqual({
      path: "notes",
      entries: [{ name: "agent.txt", type: "file" }],
    });

    await expect(
      registry.execute("read_file", { path: "../outside.txt" }),
    ).rejects.toMatchObject<Partial<ToolError>>({
      code: "TOOL_PATH_OUTSIDE_WORKSPACE",
    });
    await expect(
      registry.execute("write_file", {
        path: join(workspaceRoot, "absolute.txt"),
        content: "blocked",
      }),
    ).rejects.toMatchObject<Partial<ToolError>>({
      code: "TOOL_PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("remembers a preference in MEMORY.md without duplicating it", async () => {
    const workspaceRoot = createWorkspace();
    const registry = createToolRegistry({ workspaceRoot });

    await expect(
      registry.execute("remember", {
        memory: "The user prefers dark mode.",
      }),
    ).resolves.toEqual({
      path: "MEMORY.md",
      memory: "The user prefers dark mode.",
      updated: true,
    });
    await expect(
      registry.execute("remember", {
        memory: "The user prefers dark mode.",
      }),
    ).resolves.toMatchObject({
      updated: false,
    });
    expect(readFileSync(join(workspaceRoot, "MEMORY.md"), "utf8")).toBe(
      "# Memory\n\n- The user prefers dark mode.\n",
    );
  });
});
