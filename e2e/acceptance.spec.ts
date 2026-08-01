import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const repositoryRoot = process.cwd();
const acceptanceWorkspace = resolve(repositoryRoot, ".playwright-workspace");
let backendProcess: ChildProcess | null = null;
let frontendProcess: ChildProcess | null = null;

test.beforeAll(async () => {
  backendProcess = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/e2e/server.ts"],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  frontendProcess = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "apps/web",
      "--config",
      "apps/web/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
      "--strictPort",
    ],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  await Promise.all([
    waitForServer("http://127.0.0.1:3001/api/health", backendProcess),
    waitForServer("http://127.0.0.1:5173", frontendProcess),
  ]);
});

test.afterAll(async () => {
  await stopProcess(frontendProcess);
  await stopProcess(backendProcess);
});

test("completes a file-tool chat and blocks a filesystem escape", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "SynthiaClaw" }),
  ).toBeVisible();
  await expect(page.getByText("Backend connected")).toBeVisible();
  await expect(page.getByText("Chat connected")).toBeVisible();

  await page.getByRole("button", {
    name: "Create new conversation",
  }).click();
  await expect(
    page.getByRole("heading", { name: "New conversation" }),
  ).toBeVisible();

  await page.getByRole("textbox", { name: "Message" }).fill(
    "Create the browser acceptance file.",
  );
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Calling write_file")).toBeVisible();
  await expect(page.getByText("Tool completed")).toBeVisible();
  await expect(
    page.getByText("Created acceptance/result.txt safely."),
  ).toBeVisible();
  expect(
    readFileSync(
      resolve(
        acceptanceWorkspace,
        "files",
        "acceptance",
        "result.txt",
      ),
      "utf8",
    ),
  ).toBe("Browser acceptance passed.");

  await page.getByRole("textbox", { name: "Message" }).fill(
    "Attempt a path traversal escape.",
  );
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Tool failed")).toBeVisible();
  await expect(
    page.getByText(/TOOL_PATH_OUTSIDE_WORKSPACE/),
  ).toBeVisible();
  await expect(page.getByText("Escape attempt blocked.")).toBeVisible();
  expect(existsSync(resolve(acceptanceWorkspace, "escape.txt"))).toBe(false);
});

async function waitForServer(
  url: string,
  child: ChildProcess,
): Promise<void> {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited before startup.\n${output}`);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}.\n${output}`);
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}
