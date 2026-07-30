import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderMessage } from "./provider.js";

const IDENTITY_FILES = ["AGENT.md", "USER.md", "MEMORY.md"] as const;
const BASE_INSTRUCTIONS =
  "You are SynthiaClaw, a persistent personal agent. Use the identity and memory context above when relevant. Use the remember tool when the user explicitly asks you to retain a durable preference or fact.";

export interface BuildAgentContextOptions {
  workspaceRoot: string;
  maxChars: number;
  messages: ProviderMessage[];
}

export async function buildAgentContext(
  options: BuildAgentContextOptions,
): Promise<ProviderMessage[]> {
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const sections = await Promise.all(
    IDENTITY_FILES.map(async (filename) => {
      try {
        const content = (await readFile(
          join(options.workspaceRoot, filename),
          "utf8",
        )).trim();
        return content ? `## ${filename}\n${content}` : null;
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    }),
  );
  const identity = [
    ...sections.filter((section) => section !== null),
    BASE_INSTRUCTIONS,
  ]
    .join("\n\n")
    .slice(0, Math.floor(maxChars / 2))
    .trimEnd();
  const systemMessage: ProviderMessage = {
    role: "system",
    content: identity,
  };
  let remainingChars = maxChars - systemMessage.content.length;
  const selected: ProviderMessage[] = [];

  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index];
    if (!message) continue;
    if (message.content.length <= remainingChars) {
      selected.unshift({ ...message });
      remainingChars -= message.content.length;
      continue;
    }
    if (selected.length === 0 && remainingChars > 0) {
      selected.unshift({
        ...message,
        content: message.content.slice(0, remainingChars),
      });
    }
    break;
  }

  return [systemMessage, ...selected];
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
