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
  type ProviderStreamChunk,
  type ProviderToolExecutor,
} from "./provider.js";
import type { ProviderToolDefinition } from "./tools.js";

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

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private error: Error | null = null;

  push(value: T): void {
    if (this.ended || this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended || this.error) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.ended || this.error) return;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.error) return Promise.reject(this.error);
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

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
    developerInstructions?: string;
    model?: string;
    tools?: ProviderToolDefinition[];
  }): Promise<string> {
    const baseInstructions =
      "You are the assistant in a persistent chat application. Answer the user's request directly. Use only the dynamic tools provided by the host when they are useful.";
    const result = asRecord(
      await this.request("thread/start", {
        approvalPolicy: "never",
        cwd: options.cwd,
        developerInstructions: options.developerInstructions
          ? `${baseInstructions}\n\n${options.developerInstructions}`
          : baseInstructions,
        ephemeral: true,
        ...(options.model ? { model: options.model } : {}),
        ...(options.tools?.length ? { dynamicTools: options.tools } : {}),
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

  async *streamTurn(
    threadId: string,
    text: string,
    signal: AbortSignal,
    executeTool?: ProviderToolExecutor,
  ): AsyncIterable<ProviderStreamChunk> {
    let turnId: string | null = null;
    let completedTurn: Record<string, unknown> | null = null;
    const finalTextByTurn = new Map<string, string>();
    const pendingDeltas: Array<{ turnId: string; delta: string }> = [];
    const queue = new AsyncQueue<ProviderStreamChunk>();
    let sawDelta = false;
    let abortRequested = signal.aborted;
    let interruptSent = false;

    const finishIfReady = () => {
      if (!turnId || !completedTurn || completedTurn.id !== turnId) return;
      if (abortRequested) {
        queue.fail(new DOMException("The run was cancelled.", "AbortError"));
        return;
      }
      if (completedTurn.status !== "completed") {
        queue.fail(
          new ProviderError(
            "CODEX_TURN_FAILED",
            readTurnFailure(completedTurn),
          ),
        );
        return;
      }
      const finalText = finalTextByTurn.get(turnId);
      if (!sawDelta && finalText) {
        sawDelta = true;
        queue.push(finalText);
      }
      if (!sawDelta) {
        queue.fail(
          new ProviderError(
            "PROVIDER_INVALID_RESPONSE",
            "Codex completed the turn without assistant text.",
          ),
        );
        return;
      }
      queue.end();
    };

    const interrupt = () => {
      abortRequested = true;
      if (turnId && !interruptSent) {
        interruptSent = true;
        void this.request("turn/interrupt", { threadId, turnId }).catch(
          () => undefined,
        );
      }
      queue.fail(new DOMException("The run was cancelled.", "AbortError"));
    };

    const unsubscribe = this.subscribe((message) => {
      if (
        message.method === "item/tool/call" &&
        message.id !== undefined &&
        executeTool
      ) {
        const params = asOptionalRecord(message.params);
        if (
          params?.threadId === threadId &&
          typeof params.callId === "string" &&
          typeof params.tool === "string"
        ) {
          const argumentsValue = params.arguments;
          const displayArguments =
            typeof argumentsValue === "object" &&
            argumentsValue !== null &&
            !Array.isArray(argumentsValue)
              ? (argumentsValue as Record<string, unknown>)
              : {};
          queue.push({
            type: "tool_call",
            callId: params.callId,
            toolName: params.tool,
            arguments: displayArguments,
            providerManaged: true,
          });
          void (async () => {
            let output: string;
            let isError = false;
            try {
              output = await executeTool(params.tool as string, argumentsValue);
            } catch (error) {
              isError = true;
              output = JSON.stringify({
                error: {
                  code: "TOOL_EXECUTION_FAILED",
                  message:
                    error instanceof Error
                      ? error.message
                      : "The server tool could not be executed.",
                },
              });
            }
            queue.push({
              type: "tool_result",
              callId: params.callId as string,
              toolName: params.tool as string,
              output,
              isError,
            });
            this.transport.send({
              id: message.id,
              result: {
                contentItems: [{ type: "inputText", text: output }],
                success: !isError,
              },
            });
          })().catch((error: unknown) => {
            queue.fail(toError(error));
          });
        }
      }
      if (message.method === "item/agentMessage/delta") {
        const params = asOptionalRecord(message.params);
        if (
          params?.threadId === threadId &&
          typeof params.turnId === "string" &&
          typeof params.delta === "string" &&
          params.delta.length > 0
        ) {
          if (params.turnId === turnId && !abortRequested) {
            sawDelta = true;
            queue.push(params.delta);
          } else if (!turnId) {
            pendingDeltas.push({
              turnId: params.turnId,
              delta: params.delta,
            });
          }
        }
      }
      if (message.method === "item/completed") {
        const params = asOptionalRecord(message.params);
        const item = asOptionalRecord(params?.item);
        if (
          params?.threadId === threadId &&
          typeof params.turnId === "string" &&
          item?.type === "agentMessage" &&
          typeof item.text === "string" &&
          item.text.length > 0
        ) {
          if (
            item.phase === "final_answer" ||
            !finalTextByTurn.has(params.turnId)
          ) {
            finalTextByTurn.set(params.turnId, item.text);
          }
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
      queue.fail(error);
    });
    signal.addEventListener("abort", interrupt, { once: true });

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
      for (const pending of pendingDeltas) {
        if (pending.turnId === turnId && !abortRequested) {
          sawDelta = true;
          queue.push(pending.delta);
        }
      }
      if (abortRequested) interrupt();
      finishIfReady();
      for await (const delta of queue) yield delta;
    } finally {
      signal.removeEventListener("abort", interrupt);
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

    if (message.method) {
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

  async *stream(
    messages: ProviderMessage[],
    signal: AbortSignal = new AbortController().signal,
    tools: ProviderToolDefinition[] = [],
    executeTool?: ProviderToolExecutor,
  ): AsyncIterable<ProviderStreamChunk> {
    const systemInstructions = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const conversationMessages = messages.filter(
      (message) => message.role !== "system",
    );
    const current = conversationMessages.at(-1);
    if (!current || current.role !== "user") {
      throw new ProviderError(
        "PROVIDER_INVALID_REQUEST",
        "A Codex turn must end with a user message.",
      );
    }

    signal.throwIfAborted();
    const status = await this.client.getSubscriptionStatus();
    if (!status.ready || !status.account) {
      throw new ProviderError(
        "CODEX_NOT_AUTHENTICATED",
        "Connect a ChatGPT subscription before sending a message.",
      );
    }

    signal.throwIfAborted();
    const threadId = await this.client.startThread({
      ...this.options,
      ...(systemInstructions
        ? { developerInstructions: systemInstructions }
        : {}),
      tools: executeTool ? tools : [],
    });
    signal.throwIfAborted();
    await this.client.injectItems(threadId, conversationMessages.slice(0, -1));
    yield* this.client.streamTurn(
      threadId,
      current.content,
      signal,
      executeTool,
    );
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
