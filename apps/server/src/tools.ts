import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { z, type ZodTypeAny } from "zod";

export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

interface RegisteredTool extends ProviderToolDefinition {
  argumentsSchema: ZodTypeAny;
  run(argumentsValue: any): Promise<unknown>;
}

export interface ToolRegistry {
  definitions: ProviderToolDefinition[];
  execute(name: string, argumentsValue: unknown): Promise<unknown>;
}

export interface ToolRegistryOptions {
  workspaceRoot: string;
  now?: () => Date;
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const RelativePathSchema = z.string().min(1).max(4_096);
const NoArgumentsSchema = z.object({}).strict();
const ListFilesArgumentsSchema = z
  .object({ path: RelativePathSchema.optional().default(".") })
  .strict();
const ReadFileArgumentsSchema = z
  .object({ path: RelativePathSchema })
  .strict();
const WriteFileArgumentsSchema = z
  .object({
    path: RelativePathSchema,
    content: z.string().max(1_000_000),
  })
  .strict();

export function createToolRegistry(
  options: ToolRegistryOptions,
): ToolRegistry {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());

  const tools: RegisteredTool[] = [
    {
      name: "current_time",
      description: "Return the current time from the server as an ISO timestamp.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      argumentsSchema: NoArgumentsSchema,
      run: async () => ({ iso: now().toISOString() }),
    },
    {
      name: "list_files",
      description:
        "List the direct children of a directory inside the configured workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative directory path. Defaults to '.'.",
          },
        },
        additionalProperties: false,
      },
      argumentsSchema: ListFilesArgumentsSchema,
      run: async (argumentsValue: { path: string }) => {
        const target = await resolveExistingWorkspacePath(
          workspaceRoot,
          argumentsValue.path,
        );
        const entries = await readdir(target, { withFileTypes: true });
        if (entries.length > 1_000) {
          throw new ToolError(
            "TOOL_OUTPUT_TOO_LARGE",
            "The directory contains too many entries to return safely.",
          );
        }
        return {
          path: argumentsValue.path,
          entries: entries
            .map((entry) => ({
              name: entry.name,
              type: entry.isDirectory()
                ? ("directory" as const)
                : entry.isFile()
                  ? ("file" as const)
                  : ("other" as const),
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        };
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file inside the configured workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      argumentsSchema: ReadFileArgumentsSchema,
      run: async (argumentsValue: { path: string }) => {
        const target = await resolveExistingWorkspacePath(
          workspaceRoot,
          argumentsValue.path,
        );
        const metadata = await stat(target);
        if (metadata.size > 180_000) {
          throw new ToolError(
            "TOOL_OUTPUT_TOO_LARGE",
            "The file is too large to return as a tool result.",
          );
        }
        return {
          path: argumentsValue.path,
          content: await readFile(target, "utf8"),
        };
      },
    },
    {
      name: "write_file",
      description:
        "Write a UTF-8 text file inside the configured workspace, creating parent directories.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
          content: {
            type: "string",
            description: "Complete UTF-8 file content.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      argumentsSchema: WriteFileArgumentsSchema,
      run: async (argumentsValue: { path: string; content: string }) => {
        const target = resolveWorkspacePath(workspaceRoot, argumentsValue.path);
        const parent = dirname(target);
        await assertNearestExistingAncestorInside(workspaceRoot, parent);
        await mkdir(parent, { recursive: true });
        await assertRealPathInside(workspaceRoot, parent);
        try {
          await stat(target);
          await assertRealPathInside(workspaceRoot, target);
        } catch (error) {
          if (error instanceof ToolError || !isNotFoundError(error)) throw error;
        }
        await writeFile(target, argumentsValue.content, "utf8");
        return {
          path: argumentsValue.path,
          bytesWritten: Buffer.byteLength(argumentsValue.content, "utf8"),
        };
      },
    },
  ];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    definitions: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    async execute(name, argumentsValue) {
      const tool = toolsByName.get(name);
      if (!tool) {
        throw new ToolError(
          "TOOL_NOT_FOUND",
          `The requested tool "${name}" is not registered.`,
        );
      }
      const parsed = tool.argumentsSchema.safeParse(argumentsValue);
      if (!parsed.success) {
        throw new ToolError(
          "TOOL_ARGUMENTS_INVALID",
          `Arguments for "${name}" did not match its server schema.`,
        );
      }
      try {
        return await tool.run(parsed.data);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(
          "TOOL_EXECUTION_FAILED",
          error instanceof Error
            ? error.message
            : `The tool "${name}" could not be executed.`,
        );
      }
    },
  };
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (isAbsolute(inputPath)) {
    throw outsideWorkspaceError();
  }
  const target = resolve(workspaceRoot, inputPath);
  assertLexicallyInside(workspaceRoot, target);
  return target;
}

async function resolveExistingWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
): Promise<string> {
  const target = resolveWorkspacePath(workspaceRoot, inputPath);
  await stat(target);
  await assertRealPathInside(workspaceRoot, target);
  return target;
}

async function assertRealPathInside(
  workspaceRoot: string,
  target: string,
): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([
    realpath(workspaceRoot),
    realpath(target),
  ]);
  assertLexicallyInside(realRoot, realTarget);
}

async function assertNearestExistingAncestorInside(
  workspaceRoot: string,
  target: string,
): Promise<void> {
  let candidate = target;
  while (true) {
    try {
      await assertRealPathInside(workspaceRoot, candidate);
      return;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw outsideWorkspaceError();
      candidate = parent;
    }
  }
}

function assertLexicallyInside(workspaceRoot: string, target: string): void {
  const relativePath = relative(workspaceRoot, target);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw outsideWorkspaceError();
  }
}

function outsideWorkspaceError(): ToolError {
  return new ToolError(
    "TOOL_PATH_OUTSIDE_WORKSPACE",
    "Tool paths must stay inside the configured workspace.",
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
