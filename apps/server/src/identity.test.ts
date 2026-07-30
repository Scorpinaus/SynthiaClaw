import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAgentContext } from "./identity.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), "synthia-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("agent identity context", () => {
  it("loads AGENT.md, USER.md, and MEMORY.md into a system message", async () => {
    const workspaceRoot = createWorkspace();
    writeFileSync(join(workspaceRoot, "AGENT.md"), "Be concise.", "utf8");
    writeFileSync(join(workspaceRoot, "USER.md"), "The user is Sam.", "utf8");
    writeFileSync(
      join(workspaceRoot, "MEMORY.md"),
      "# Memory\n\n- Prefers dark mode.\n",
      "utf8",
    );

    const messages = await buildAgentContext({
      workspaceRoot,
      maxChars: 2_000,
      messages: [{ role: "user", content: "What do I prefer?" }],
    });

    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).toContain("## AGENT.md\nBe concise.");
    expect(messages[0]?.content).toContain("## USER.md\nThe user is Sam.");
    expect(messages[0]?.content).toContain(
      "## MEMORY.md\n# Memory\n\n- Prefers dark mode.",
    );
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "What do I prefer?",
    });
  });

  it("keeps the newest conversation turns within the configured character limit", async () => {
    const messages = await buildAgentContext({
      workspaceRoot: createWorkspace(),
      maxChars: 360,
      messages: [
        { role: "user", content: `old:${"o".repeat(180)}` },
        { role: "assistant", content: `middle:${"m".repeat(120)}` },
        { role: "user", content: "latest preference question" },
      ],
    });

    expect(
      messages.reduce((total, message) => total + message.content.length, 0),
    ).toBeLessThanOrEqual(360);
    expect(messages.some((message) => message.content.startsWith("old:"))).toBe(
      false,
    );
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "latest preference question",
    });
  });

  it("bounds oversized identity files and tolerates missing files", async () => {
    const workspaceRoot = createWorkspace();
    writeFileSync(
      join(workspaceRoot, "MEMORY.md"),
      `# Memory\n\n- ${"preference ".repeat(100)}`,
      "utf8",
    );

    const messages = await buildAgentContext({
      workspaceRoot,
      maxChars: 240,
      messages: [{ role: "user", content: "Recall my preference." }],
    });

    expect(
      messages.reduce((total, message) => total + message.content.length, 0),
    ).toBeLessThanOrEqual(240);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.content).toContain("## MEMORY.md");
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: "Recall my preference.",
    });
  });
});
