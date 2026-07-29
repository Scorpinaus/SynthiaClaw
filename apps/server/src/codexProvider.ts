import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import {
  CodexLoginResponseSchema,
  ProviderStatusResponseSchema,
  type CodexPlanType,
  type ProviderStatusResponse,
} from "@synthia/shared";

import {
  ProviderError,
  type CodexAccountManager,
  type ModelProvider,
  type ProviderMessage,
} from "./provider.js";

export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface CodexTransport {
  start(
    onMessage: (message: JsonRpcMessage) => void,
    onExit: (error: Error) => void,
  ): Promise<void>;
  send(message: JsonRpcMessage): void;
  close(): Promise<void>;
}

export interface StdioCodexTransportOptions {
  command?: string;
  cwd?: string;
}

export class StdioCodexTransport implements CodexTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private closing = false;
  private stderr = "";

  constructor(private readonly options: StdioCodexTransportOptions = {}) {}

  async start(
    onMessage: (message: JsonRpcMessage) => void,
    onExit: (error: Error) => void,
  ): Promise<void> {
    if (this.child) return;

    const child = spawn(this.options.command ?? "codex", ["app-server", "--stdio"], {
      cwd: this.options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });

    this.lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        onMessage(JSON.parse(line) as JsonRpcMessage);
      } catch {
        onExit(
          new ProviderError(
            "CODEX_PROTOCOL_ERROR",
            "Codex app-server returned an invalid protocol message.",
          ),
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8_192);
    });
    child.once("exit", (code, signal) => {
      this.child = null;
      this.lines?.close();
      this.lines = null;
      if (!this.closing) {
        const detail = this.stderr.trim();
        const suffix = detail
          ? ` ${detail}`
          : ` (exit ${code ?? "unknown"}, signal ${signal ?? "none"}).`;
        onExit(
          new ProviderError(
            "CODEX_APP_SERVER_EXITED",
            `Codex app-server exited unexpectedly.${suffix}`,
          ),
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        this.child = null;
        reject(
          new ProviderError(
            "CODEX_APP_SERVER_UNAVAILABLE",
            `Codex app-server could not be started: ${error.message}`,
          ),
        );
      });
    });
  }

  send(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) {
      throw new ProviderError(
        "CODEX_APP_SERVER_UNAVAILABLE",
        "Codex app-server is not running.",
      );
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      timeout.unref();
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.stdin.end();
      child.kill();
    });
  }
}

type NotificationListener = (message: JsonRpcMessage) => void;
type ExitListener = (error: Error) => void;

export class CodexAppServerClient implements CodexAccountManager {
  private nextId = 1;
  private startPromise: Promise<void> | null = null;
  private readonly pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly listeners = new Set<NotificationListener>();
  private readonly exitListeners = new Set<ExitListener>();

  constructor(private readonly transport: CodexTransport) {}

  async getSubscriptionStatus(): Promise<ProviderStatusResponse> {
    const result = asRecord(
      await this.request("account/read", { refreshToken: false }),
    );
    const account = asOptionalRecord(result.account);
    if (account?.type !== "chatgpt") {
      return ProviderStatusResponseSchema.parse({
        mode: "codex-subscription",
        ready: false,
        account: null,
      });
    }

    return ProviderStatusResponseSchema.parse({
      mode: "codex-subscription",
      ready: true,
      account: {
        email: typeof account.email === "string" ? account.email : null,
        planType: normalizePlanType(account.planType),
      },
    });
  }

  async startChatGptLogin() {
    const result = asRecord(
      await this.request("account/login/start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "chatgpt",
      }),
    );
    if (result.type !== "chatgpt") {
      throw new ProviderError(
        "CODEX_LOGIN_FAILED",
        "Codex did not start a ChatGPT OAuth login.",
      );
    }
    return CodexLoginResponseSchema.parse({
      loginId: result.loginId,
      authUrl: result.authUrl,
    });
  }

  async logout(): Promise<void> {
    await this.request("account/logout");
  }

  async startThread(options: {
    cwd: string;
    model?: string;
  }): Promise<string> {
    const result = asRecord(
      await this.request("thread/start", {
        approvalPolicy: "never",
        cwd: options.cwd,
        developerInstructions:
          "You are the assistant in a persistent chat application. Answer the user's request directly. Do not use tools or modify files.",
        ephemeral: true,
        ...(options.model ? { model: options.model } : {}),
        sandbox: "read-only",
      }),
    );
    const thread = asRecord(result.thread);
    if (typeof thread.id !== "string" || !thread.id) {
      throw new ProviderError(
        "CODEX_PROTOCOL_ERROR",
        "Codex did not return a thread identifier.",
      );
    }
    return thread.id;
  }

  async injectItems(threadId: string, messages: ProviderMessage[]) {
    if (messages.length === 0) return;
    await this.request("thread/inject_items", {
      threadId,
      items: messages.map((message) => ({
        type: "message",
        role: message.role,
        content: [
          {
            type: message.role === "user" ? "input_text" : "output_text",
            text: message.content,
          },
        ],
      })),
    });
  }

  async completeTurn(threadId: string, text: string): Promise<string> {
    let turnId: string | null = null;
    let completedTurn: Record<string, unknown> | null = null;
    let assistantText: string | null = null;
    let resolveCompletion!: (value: string) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<string>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const finishIfReady = () => {
      if (!turnId || !completedTurn || completedTurn.id !== turnId) return;
      if (completedTurn.status !== "completed") {
        rejectCompletion(
          new ProviderError(
            "CODEX_TURN_FAILED",
            readTurnFailure(completedTurn),
          ),
        );
        return;
      }
      if (!assistantText) {
        rejectCompletion(
          new ProviderError(
            "PROVIDER_INVALID_RESPONSE",
            "Codex completed the turn without assistant text.",
          ),
        );
        return;
      }
      resolveCompletion(assistantText);
    };

    const unsubscribe = this.subscribe((message) => {
      if (message.method === "item/completed") {
        const params = asOptionalRecord(message.params);
        const item = asOptionalRecord(params?.item);
        if (
          params?.threadId === threadId &&
          item?.type === "agentMessage" &&
          typeof item.text === "string" &&
          item.text.length > 0 &&
          (item.phase === "final_answer" || assistantText === null)
        ) {
          assistantText = item.text;
        }
      }
      if (message.method === "turn/completed") {
        const params = asOptionalRecord(message.params);
        const turn = asOptionalRecord(params?.turn);
        if (params?.threadId === threadId && turn) {
          completedTurn = turn;
          finishIfReady();
        }
      }
    });
    const unsubscribeExit = this.subscribeToExit((error) => {
      rejectCompletion(error);
    });

    try {
      const result = asRecord(
        await this.request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
        }),
      );
      const turn = asRecord(result.turn);
      if (typeof turn.id !== "string" || !turn.id) {
        throw new ProviderError(
          "CODEX_PROTOCOL_ERROR",
          "Codex did not return a turn identifier.",
        );
      }
      turnId = turn.id;
      finishIfReady();
      return await completion;
    } finally {
      unsubscribe();
      unsubscribeExit();
    }
  }

  async close(): Promise<void> {
    const error = new ProviderError(
      "CODEX_APP_SERVER_CLOSED",
      "Codex app-server was closed.",
    );
    this.handleExit(error);
    await this.transport.close();
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.requestRaw(method, params);
  }

  private ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = (async () => {
        await this.transport.start(
          (message) => this.receive(message),
          (error) => this.handleExit(error),
        );
        await this.requestRaw("initialize", {
          clientInfo: {
            name: "synthia-claw",
            title: "SynthiaClaw",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        });
        this.transport.send({ method: "initialized", params: {} });
      })();
    }
    return this.startPromise;
  }

  private requestRaw(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.send({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  private receive(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new ProviderError(
            "CODEX_REQUEST_FAILED",
            message.error.message || "Codex app-server rejected the request.",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id === undefined) {
      for (const listener of this.listeners) listener(message);
    }
  }

  private subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private subscribeToExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private handleExit(error: Error): void {
    this.rejectPending(error);
    for (const listener of this.exitListeners) listener(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export interface CodexSubscriptionProviderOptions {
  cwd: string;
  model?: string;
}

export class CodexSubscriptionProvider implements ModelProvider {
  constructor(
    private readonly client: CodexAppServerClient,
    private readonly options: CodexSubscriptionProviderOptions,
  ) {}

  async complete(messages: ProviderMessage[]): Promise<string> {
    const current = messages.at(-1);
    if (!current || current.role !== "user") {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        "A Codex turn must end with a user message.",
      );
    }

    const status = await this.client.getSubscriptionStatus();
    if (!status.ready || !status.account) {
      throw new ProviderError(
        "CODEX_NOT_AUTHENTICATED",
        "Connect a ChatGPT subscription before sending a message.",
      );
    }

    const threadId = await this.client.startThread(this.options);
    await this.client.injectItems(threadId, messages.slice(0, -1));
    return this.client.completeTurn(threadId, current.content);
  }
}

const knownPlanTypes = new Set<CodexPlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

function normalizePlanType(value: unknown): CodexPlanType {
  return typeof value === "string" &&
    knownPlanTypes.has(value as CodexPlanType)
    ? (value as CodexPlanType)
    : "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderError(
      "CODEX_PROTOCOL_ERROR",
      "Codex app-server returned an unexpected response.",
    );
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(
  value: unknown,
): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTurnFailure(turn: Record<string, unknown>): string {
  const error = asOptionalRecord(turn.error);
  return typeof error?.message === "string"
    ? error.message
    : `Codex turn ended with status ${String(turn.status)}.`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
