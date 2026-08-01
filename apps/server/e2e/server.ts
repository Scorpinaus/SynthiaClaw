import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { buildApp } from "../src/app.js";
import type { ModelProvider } from "../src/provider.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workspaceRoot = resolve(repositoryRoot, ".playwright-workspace");
if (
  dirname(workspaceRoot) !== repositoryRoot ||
  basename(workspaceRoot) !== ".playwright-workspace"
) {
  throw new Error("The Playwright workspace path is not safely scoped.");
}
rmSync(workspaceRoot, { recursive: true, force: true });
mkdirSync(workspaceRoot, { recursive: true });

const provider: ModelProvider = {
  async *stream(messages) {
    const latest = messages.at(-1);
    if (latest?.role === "tool") {
      yield latest.content.includes("TOOL_PATH_OUTSIDE_WORKSPACE")
        ? "Escape attempt blocked."
        : "Created acceptance/result.txt safely.";
      return;
    }

    const escapeAttempt = latest?.content.includes("path traversal") ?? false;
    yield {
      type: "tool_call",
      callId: escapeAttempt
        ? "call_e2e_escape"
        : "call_e2e_acceptance_write",
      toolName: "write_file",
      arguments: escapeAttempt
        ? {
            path: "../escape.txt",
            content: "This must never be written.",
          }
        : {
            path: "acceptance/result.txt",
            content: "Browser acceptance passed.",
          },
    };
  },
};

const app = buildApp(
  { logger: false },
  {
    databasePath: resolve(workspaceRoot, "synthia.sqlite"),
    provider,
    frontendOrigin: "http://127.0.0.1:5173",
    agent: {
      workspaceRoot,
      maxIterations: 4,
      timeoutMs: 5_000,
    },
  },
);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: "127.0.0.1", port: 3001 });
