import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexLoginResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  MessageListResponseSchema,
  ProviderStatusResponseSchema,
  ServerWebSocketEventSchema,
  SessionListResponseSchema,
  SessionResponseSchema,
  type ServerWebSocketEvent,
} from "@synthia/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import type {
  CodexAccountManager,
  ModelProvider,
  ProviderRuntime,
} from "./provider.js";

const stream = vi.fn<ModelProvider["stream"]>(async function* (messages) {
  const latest = messages.at(-1);
  yield `Echo: ${latest?.content ?? ""}`;
});
const app = buildApp(
  { logger: false },
  { databasePath: ":memory:", provider: { stream } },
);

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  stream.mockClear();
});

async function createSession(title: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { title },
  });
  return SessionResponseSchema.parse(response.json()).session;
}

describe("GET /api/health", () => {
  it("returns a schema-valid health response", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);

    const body = HealthResponseSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.service).toBe("synthia-server");
  });

  it("uses a JSON content type", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.headers["content-type"]).toContain("application/json");
  });
});

describe("model provider REST API", () => {
  it("reports API-key mode for the existing provider", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/provider",
    });

    expect(response.statusCode).toBe(200);
    expect(ProviderStatusResponseSchema.parse(response.json())).toEqual({
      mode: "openai-api",
      ready: true,
      account: null,
    });
  });

  it("starts OAuth, reports the connected subscription, and logs out", async () => {
    const accountManager: CodexAccountManager = {
      getSubscriptionStatus: vi.fn().mockResolvedValue({
        mode: "codex-subscription",
        ready: true,
        account: {
          email: "person@example.com",
          planType: "plus",
        },
      }),
      startChatGptLogin: vi.fn().mockResolvedValue({
        loginId: "019c1234-5678-7abc-8def-0123456789ab",
        authUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
      }),
      logout: vi.fn().mockResolvedValue(undefined),
    };
    const runtime: ProviderRuntime = {
      mode: "codex-subscription",
      provider: { stream },
      accountManager,
      close: vi.fn().mockResolvedValue(undefined),
    };
    const authApp = buildApp(
      { logger: false },
      { databasePath: ":memory:", providerRuntime: runtime },
    );

    try {
      const statusResponse = await authApp.inject({
        method: "GET",
        url: "/api/provider",
      });
      expect(
        ProviderStatusResponseSchema.parse(statusResponse.json()),
      ).toMatchObject({
        mode: "codex-subscription",
        ready: true,
        account: { planType: "plus" },
      });

      const loginResponse = await authApp.inject({
        method: "POST",
        url: "/api/provider/codex/login",
      });
      expect(loginResponse.statusCode).toBe(200);
      expect(CodexLoginResponseSchema.parse(loginResponse.json())).toEqual({
        loginId: "019c1234-5678-7abc-8def-0123456789ab",
        authUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
      });

      const logoutResponse = await authApp.inject({
        method: "POST",
        url: "/api/provider/codex/logout",
      });
      expect(logoutResponse.statusCode).toBe(204);
      expect(accountManager.logout).toHaveBeenCalledOnce();
    } finally {
      await authApp.close();
    }
  });

  it("does not expose Codex OAuth routes in API-key mode", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/provider/codex/login",
    });

    expect(response.statusCode).toBe(409);
    expect(ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "CODEX_PROVIDER_DISABLED",
    );
  });
});

describe("WebSocket chat API", () => {
  it("runs a server tool loop and emits the call and result before the final response", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "synthia-agent-loop-"));
    const agentStream = vi.fn<ModelProvider["stream"]>(
      async function* (messages, _signal, tools) {
        expect(tools?.map((tool) => tool.name)).toEqual([
          "current_time",
          "list_files",
          "read_file",
          "write_file",
          "remember",
        ]);
        const latest = messages.at(-1);
        if (latest?.role === "tool") {
          yield `The server time is ${JSON.parse(latest.content).iso}.`;
          return;
        }
        yield {
          type: "tool_call",
          callId: "call_time_1",
          toolName: "current_time",
          arguments: {},
        };
      },
    );
    const agentApp = buildApp(
      { logger: false },
      {
        databasePath: ":memory:",
        provider: { stream: agentStream },
        agent: {
          workspaceRoot,
          maxIterations: 4,
          timeoutMs: 1_000,
          now: () => new Date("2026-07-30T12:34:56.000Z"),
        },
      },
    );

    try {
      const createResponse = await agentApp.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Agent time" },
      });
      const session = SessionResponseSchema.parse(createResponse.json()).session;
      const socket = await agentApp.injectWS("/api/chat");
      const lifecycle = new Promise<ServerWebSocketEvent[]>(
        (resolve, reject) => {
          const events: ServerWebSocketEvent[] = [];
          socket.once("error", reject);
          socket.on("message", (data) => {
            events.push(
              ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
            );
            if (events.at(-1)?.type === "assistant.completed") resolve(events);
          });
        },
      );

      socket.send(
        JSON.stringify({
          type: "chat.send",
          requestId: "req_tool_loop_1",
          sessionId: session.id,
          text: "What time is it?",
        }),
      );

      await expect(lifecycle).resolves.toMatchObject([
        { type: "run.started" },
        {
          type: "tool.call",
          callId: "call_time_1",
          toolName: "current_time",
          arguments: {},
        },
        {
          type: "tool.result",
          callId: "call_time_1",
          toolName: "current_time",
          isError: false,
          output: '{"iso":"2026-07-30T12:34:56.000Z"}',
        },
        {
          type: "assistant.delta",
          delta: "The server time is 2026-07-30T12:34:56.000Z.",
        },
        { type: "assistant.completed" },
      ]);
      expect(agentStream).toHaveBeenCalledTimes(2);
      socket.close();
    } finally {
      await agentApp.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("recalls a remembered preference in a new session with bounded identity context", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "synthia-memory-"));
    writeFileSync(join(workspaceRoot, "AGENT.md"), "Be concise.", "utf8");
    writeFileSync(join(workspaceRoot, "USER.md"), "The user is Sam.", "utf8");
    let modelCall = 0;
    const memoryStream = vi.fn<ModelProvider["stream"]>(
      async function* (messages, _signal, tools) {
        modelCall += 1;
        if (modelCall === 1) {
          expect(tools?.map((tool) => tool.name)).toContain("remember");
          expect(messages[0]).toMatchObject({ role: "system" });
          expect(messages[0]?.content).toContain("## AGENT.md\nBe concise.");
          expect(messages[0]?.content).toContain(
            "## USER.md\nThe user is Sam.",
          );
          expect(
            messages.reduce(
              (total, message) => total + message.content.length,
              0,
            ),
          ).toBeLessThanOrEqual(800);
          yield {
            type: "tool_call",
            callId: "call_remember_dark_mode",
            toolName: "remember",
            arguments: { memory: "The user prefers dark mode." },
          };
          return;
        }
        if (modelCall === 2) {
          yield "I will remember that preference.";
          return;
        }

        expect(messages[0]).toMatchObject({ role: "system" });
        expect(messages[0]?.content).toContain(
          "## MEMORY.md\n# Memory\n\n- The user prefers dark mode.",
        );
        expect(messages.at(-1)).toEqual({
          role: "user",
          content: "What interface theme do I prefer?",
        });
        yield "You prefer dark mode.";
      },
    );
    const memoryApp = buildApp(
      { logger: false },
      {
        databasePath: ":memory:",
        provider: { stream: memoryStream },
        agent: {
          workspaceRoot,
          maxContextChars: 800,
          maxIterations: 4,
          timeoutMs: 1_000,
        },
      },
    );

    try {
      const createSession = async (title: string) => {
        const response = await memoryApp.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { title },
        });
        return SessionResponseSchema.parse(response.json()).session;
      };
      const firstSession = await createSession("Remember preference");
      const secondSession = await createSession("Recall preference");
      const socket = await memoryApp.injectWS("/api/chat");
      const receiveCompletedLifecycle = () =>
        new Promise<ServerWebSocketEvent[]>((resolve, reject) => {
          const events: ServerWebSocketEvent[] = [];
          const onMessage = (data: { toString(): string }) => {
            const event = ServerWebSocketEventSchema.parse(
              JSON.parse(data.toString()),
            );
            events.push(event);
            if (event.type === "run.failed") {
              socket.off("message", onMessage);
              reject(new Error(`${event.error.code}: ${event.error.message}`));
            } else if (event.type === "assistant.completed") {
              socket.off("message", onMessage);
              resolve(events);
            }
          };
          socket.once("error", reject);
          socket.on("message", onMessage);
        });

      const remembered = receiveCompletedLifecycle();
      socket.send(
        JSON.stringify({
          type: "chat.send",
          requestId: "req_remember_preference_1",
          sessionId: firstSession.id,
          text: "Remember that I prefer dark mode.",
        }),
      );
      await expect(remembered).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool.result",
            toolName: "remember",
            isError: false,
          }),
        ]),
      );

      const recalled = receiveCompletedLifecycle();
      socket.send(
        JSON.stringify({
          type: "chat.send",
          requestId: "req_recall_preference_1",
          sessionId: secondSession.id,
          text: "What interface theme do I prefer?",
        }),
      );
      await expect(recalled).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "assistant.completed",
            message: expect.objectContaining({
              payload: { text: "You prefer dark mode." },
            }),
          }),
        ]),
      );
      expect(memoryStream).toHaveBeenCalledTimes(3);
      socket.close();
    } finally {
      await memoryApp.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("fails runs that exceed the tool iteration limit", async () => {
    let callNumber = 0;
    const loopingStream = vi.fn<ModelProvider["stream"]>(async function* () {
      callNumber += 1;
      yield {
        type: "tool_call",
        callId: `call_loop_${callNumber}`,
        toolName: "current_time",
        arguments: {},
      };
    });
    const limitedApp = buildApp(
      { logger: false },
      {
        databasePath: ":memory:",
        provider: { stream: loopingStream },
        agent: {
          workspaceRoot: process.cwd(),
          maxIterations: 2,
          timeoutMs: 1_000,
        },
      },
    );

    try {
      const created = await limitedApp.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Iteration limit" },
      });
      const session = SessionResponseSchema.parse(created.json()).session;
      const socket = await limitedApp.injectWS("/api/chat");
      const failure = new Promise<ServerWebSocketEvent>((resolve, reject) => {
        socket.once("error", reject);
        socket.on("message", (data) => {
          const event = ServerWebSocketEventSchema.parse(
            JSON.parse(data.toString()),
          );
          if (event.type === "run.failed") resolve(event);
        });
      });

      socket.send(
        JSON.stringify({
          type: "chat.send",
          requestId: "req_iteration_limit_1",
          sessionId: session.id,
          text: "Loop forever",
        }),
      );

      await expect(failure).resolves.toMatchObject({
        type: "run.failed",
        error: { code: "AGENT_ITERATION_LIMIT" },
      });
      expect(loopingStream).toHaveBeenCalledTimes(2);
      socket.close();
    } finally {
      await limitedApp.close();
    }
  });

  it("aborts and fails runs after the configured timeout", async () => {
    const timeoutStream = vi.fn<ModelProvider["stream"]>(
      async function* (_messages, signal) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(new DOMException("The run timed out.", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const timeoutApp = buildApp(
      { logger: false },
      {
        databasePath: ":memory:",
        provider: { stream: timeoutStream },
        agent: {
          workspaceRoot: process.cwd(),
          maxIterations: 4,
          timeoutMs: 20,
        },
      },
    );

    try {
      const created = await timeoutApp.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Timeout" },
      });
      const session = SessionResponseSchema.parse(created.json()).session;
      const socket = await timeoutApp.injectWS("/api/chat");
      const failure = new Promise<ServerWebSocketEvent>((resolve, reject) => {
        socket.once("error", reject);
        socket.on("message", (data) => {
          const event = ServerWebSocketEventSchema.parse(
            JSON.parse(data.toString()),
          );
          if (event.type === "run.failed") resolve(event);
        });
      });

      socket.send(
        JSON.stringify({
          type: "chat.send",
          requestId: "req_timeout_1",
          sessionId: session.id,
          text: "Take too long",
        }),
      );

      await expect(failure).resolves.toMatchObject({
        type: "run.failed",
        error: { code: "AGENT_TIMEOUT" },
      });
      socket.close();
    } finally {
      await timeoutApp.close();
    }
  });

  it("persists one user message and one complete assistant response", async () => {
    const session = await createSession("WebSocket chat");
    const socket = await app.injectWS("/api/chat");
    const eventsPromise = new Promise<ServerWebSocketEvent[]>(
      (resolve, reject) => {
        const events: ServerWebSocketEvent[] = [];
        socket.on("error", reject);
        socket.on("message", (data) => {
          events.push(ServerWebSocketEventSchema.parse(JSON.parse(data.toString())));
          if (events.length === 3) {
            resolve(events);
          }
        });
      },
    );

    socket.send(
      JSON.stringify({
        type: "chat.send",
        requestId: "req_ws_1",
        sessionId: session.id,
        text: "Hello over WebSocket",
      }),
    );
    const events = await eventsPromise;
    socket.close();

    expect(events[0]).toMatchObject({
      type: "run.started",
      requestId: "req_ws_1",
      sessionId: session.id,
    });
    expect(events[1]).toMatchObject({
      type: "assistant.delta",
      requestId: "req_ws_1",
      sessionId: session.id,
      delta: "Echo: Hello over WebSocket",
    });
    expect(events[2]).toMatchObject({
      type: "assistant.completed",
      requestId: "req_ws_1",
      sessionId: session.id,
      message: {
        role: "assistant",
        payload: { text: "Echo: Hello over WebSocket" },
      },
    });
    expect(stream).toHaveBeenCalledWith(
      [
        expect.objectContaining({ role: "system" }),
        { role: "user", content: "Hello over WebSocket" },
      ],
      expect.any(AbortSignal),
      expect.arrayContaining([
        expect.objectContaining({ name: "current_time" }),
        expect.objectContaining({ name: "read_file" }),
        expect.objectContaining({ name: "remember" }),
      ]),
      expect.any(Function),
    );

    const history = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages`,
    });
    expect(
      MessageListResponseSchema.parse(history.json()).messages,
    ).toMatchObject([
      { role: "user", payload: { text: "Hello over WebSocket" } },
      {
        role: "assistant",
        payload: { text: "Echo: Hello over WebSocket" },
      },
    ]);
  });

  it("replays a completed duplicate request without duplicating messages", async () => {
    const session = await createSession("Duplicate request");
    const socket = await app.injectWS("/api/chat");
    const payload = {
      type: "chat.send",
      requestId: "req_duplicate_1",
      sessionId: session.id,
      text: "Only once",
    };

    const receiveLifecycle = (eventCount: number) =>
      new Promise<ServerWebSocketEvent[]>((resolve, reject) => {
        const events: ServerWebSocketEvent[] = [];
        const onMessage = (data: { toString(): string }) => {
          events.push(
            ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
          );
          if (events.length === eventCount) {
            socket.off("message", onMessage);
            resolve(events);
          }
        };
        socket.once("error", reject);
        socket.on("message", onMessage);
      });

    const firstLifecycle = receiveLifecycle(3);
    socket.send(JSON.stringify(payload));
    await firstLifecycle;
    const replayLifecycle = receiveLifecycle(2);
    socket.send(JSON.stringify(payload));
    const replay = await replayLifecycle;
    socket.close();

    expect(replay.map((event) => event.type)).toEqual([
      "run.started",
      "assistant.completed",
    ]);
    expect(stream).toHaveBeenCalledTimes(1);

    const history = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages`,
    });
    expect(
      MessageListResponseSchema.parse(history.json()).messages,
    ).toHaveLength(2);
  });

  it("returns a schema-valid failure for invalid inbound payloads", async () => {
    const session = await createSession("Invalid request");
    const socket = await app.injectWS("/api/chat");
    const failurePromise = new Promise<ServerWebSocketEvent>(
      (resolve, reject) => {
        socket.once("error", reject);
        socket.once("message", (data) => {
          resolve(
            ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
          );
        });
      },
    );

    socket.send(
      JSON.stringify({
        type: "chat.send",
        requestId: "req_invalid_1",
        sessionId: session.id,
        text: " ",
      }),
    );
    const failure = await failurePromise;
    socket.close();

    expect(failure).toMatchObject({
      type: "run.failed",
      requestId: "req_invalid_1",
      sessionId: session.id,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it("releases the session lock when the provider fails", async () => {
    const session = await createSession("Provider failure");
    stream.mockImplementationOnce(async function* () {
      throw new Error("provider offline");
    });
    const socket = await app.injectWS("/api/chat");

    const receiveLifecycle = (eventCount: number) =>
      new Promise<ServerWebSocketEvent[]>((resolve, reject) => {
        const events: ServerWebSocketEvent[] = [];
        const onMessage = (data: { toString(): string }) => {
          events.push(
            ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
          );
          if (events.length === eventCount) {
            socket.off("message", onMessage);
            resolve(events);
          }
        };
        socket.once("error", reject);
        socket.on("message", onMessage);
      });

    const failedLifecycle = receiveLifecycle(2);
    socket.send(
      JSON.stringify({
        type: "chat.send",
        requestId: "req_failure_1",
        sessionId: session.id,
        text: "Fail",
      }),
    );
    expect((await failedLifecycle)[1]).toMatchObject({
      type: "run.failed",
      error: { code: "PROVIDER_FAILED" },
    });

    const completedLifecycle = receiveLifecycle(3);
    socket.send(
      JSON.stringify({
        type: "chat.send",
        requestId: "req_after_failure_1",
        sessionId: session.id,
        text: "Try again",
      }),
    );
    expect((await completedLifecycle)[2]?.type).toBe("assistant.completed");
    socket.close();
  });

  it("streams deltas, cancels the provider, and replays cancellation", async () => {
    let providerAborted = false;
    const cancellingStream = vi.fn<ModelProvider["stream"]>(
      async function* (_messages, signal) {
        yield "Partial response";
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            providerAborted = true;
            reject(new DOMException("The run was cancelled.", "AbortError"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    );
    const cancelApp = buildApp(
      { logger: false },
      { databasePath: ":memory:", provider: { stream: cancellingStream } },
    );

    try {
      const createResponse = await cancelApp.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Cancellation" },
      });
      const session = SessionResponseSchema.parse(
        createResponse.json(),
      ).session;
      const socket = await cancelApp.injectWS("/api/chat");
      const receiveEvents = (eventCount: number) =>
        new Promise<ServerWebSocketEvent[]>((resolve, reject) => {
          const events: ServerWebSocketEvent[] = [];
          const onMessage = (data: { toString(): string }) => {
            events.push(
              ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
            );
            if (events.length === eventCount) {
              socket.off("message", onMessage);
              resolve(events);
            }
          };
          socket.once("error", reject);
          socket.on("message", onMessage);
        });
      const request = {
        type: "chat.send",
        requestId: "req_cancel_ws_1",
        sessionId: session.id,
        text: "Stop this response",
      };

      const partialLifecycle = receiveEvents(2);
      socket.send(JSON.stringify(request));
      const [started, delta] = await partialLifecycle;
      expect(delta).toMatchObject({
        type: "assistant.delta",
        delta: "Partial response",
      });
      expect(started.type).toBe("run.started");
      if (started.type !== "run.started") {
        throw new Error("Expected a run.started event.");
      }

      const cancelledEvent = receiveEvents(1);
      socket.send(
        JSON.stringify({
          type: "run.cancel",
          requestId: request.requestId,
          runId: started.runId,
          sessionId: session.id,
        }),
      );
      await expect(cancelledEvent).resolves.toMatchObject([
        {
          type: "run.cancelled",
          requestId: request.requestId,
          runId: started.runId,
          sessionId: session.id,
        },
      ]);
      await vi.waitFor(() => expect(providerAborted).toBe(true));

      const replayLifecycle = receiveEvents(2);
      socket.send(JSON.stringify(request));
      await expect(replayLifecycle).resolves.toMatchObject([
        { type: "run.started", runId: started.runId },
        { type: "run.cancelled", runId: started.runId },
      ]);
      expect(cancellingStream).toHaveBeenCalledTimes(1);

      const history = await cancelApp.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/messages`,
      });
      expect(
        MessageListResponseSchema.parse(history.json()).messages,
      ).toMatchObject([
        { role: "user", payload: { text: "Stop this response" } },
      ]);
      socket.close();
    } finally {
      await cancelApp.close();
    }
  });

  it("aborts an in-flight provider run when its WebSocket disconnects", async () => {
    let callCount = 0;
    let resolveAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const disconnectStream = vi.fn<ModelProvider["stream"]>(
      async function* (_messages, signal) {
        callCount += 1;
        if (callCount > 1) {
          yield "Recovered";
          return;
        }
        yield "Still running";
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              resolveAbort();
              reject(
                new DOMException("The socket disconnected.", "AbortError"),
              );
            },
            { once: true },
          );
        });
      },
    );
    const disconnectApp = buildApp(
      { logger: false },
      { databasePath: ":memory:", provider: { stream: disconnectStream } },
    );

    try {
      const createResponse = await disconnectApp.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Disconnect" },
      });
      const session = SessionResponseSchema.parse(
        createResponse.json(),
      ).session;
      const socket = await disconnectApp.injectWS("/api/chat");
      const partialLifecycle = new Promise<ServerWebSocketEvent[]>(
        (resolve, reject) => {
          const events: ServerWebSocketEvent[] = [];
          socket.once("error", reject);
          socket.on("message", (data) => {
            events.push(
              ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
            );
            if (events.length === 2) resolve(events);
          });
        },
      );
      socket.send(
        JSON.stringify({
          type: "chat.send",
          requestId: "req_disconnect_1",
          sessionId: session.id,
          text: "Keep going",
        }),
      );
      expect((await partialLifecycle)[1]).toMatchObject({
        type: "assistant.delta",
        delta: "Still running",
      });
      socket.terminate();
      await abortObserved;

      const recoverySocket = await disconnectApp.injectWS("/api/chat");
      const recoveredLifecycle = new Promise<ServerWebSocketEvent[]>(
        (resolve, reject) => {
          const events: ServerWebSocketEvent[] = [];
          recoverySocket.once("error", reject);
          recoverySocket.on("message", (data) => {
            events.push(
              ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
            );
            if (events.length === 3) resolve(events);
          });
        },
      );
      recoverySocket.send(
        JSON.stringify({
          type: "chat.send",
          requestId: "req_disconnect_recovery_1",
          sessionId: session.id,
          text: "Try again",
        }),
      );
      expect((await recoveredLifecycle).map((event) => event.type)).toEqual([
        "run.started",
        "assistant.delta",
        "assistant.completed",
      ]);
      recoverySocket.close();
    } finally {
      await disconnectApp.close();
    }
  });
});

describe("conversation persistence", () => {
  it("serves the complete conversation after a backend restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synthia-app-restart-"));
    const databasePath = join(directory, "chat.sqlite");
    const firstApp = buildApp(
      { logger: false },
      { databasePath, provider: { stream } },
    );
    let firstAppClosed = false;

    try {
      const createdResponse = await firstApp.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { title: "Restart-safe conversation" },
      });
      const { session } = SessionResponseSchema.parse(createdResponse.json());
      const socket = await firstApp.injectWS("/api/chat");
      const completion = new Promise<ServerWebSocketEvent>((resolve, reject) => {
        socket.on("error", reject);
        socket.on("message", (data) => {
          const event = ServerWebSocketEventSchema.parse(
            JSON.parse(data.toString()),
          );
          if (event.type === "assistant.completed") {
            resolve(event);
          }
        });
      });

      socket.send(
        JSON.stringify({
          type: "chat.send",
          requestId: "req_restart_acceptance_1",
          sessionId: session.id,
          text: "Survive the restart",
        }),
      );
      await completion;
      socket.close();
      await firstApp.close();
      firstAppClosed = true;

      const restartedApp = buildApp(
        { logger: false },
        { databasePath, provider: { stream } },
      );
      try {
        const sessionsResponse = await restartedApp.inject({
          method: "GET",
          url: "/api/sessions",
        });
        expect(
          SessionListResponseSchema.parse(sessionsResponse.json()).sessions,
        ).toContainEqual(
          expect.objectContaining({
            id: session.id,
            title: "Restart-safe conversation",
          }),
        );

        const messagesResponse = await restartedApp.inject({
          method: "GET",
          url: `/api/sessions/${session.id}/messages`,
        });
        expect(
          MessageListResponseSchema.parse(messagesResponse.json()).messages,
        ).toMatchObject([
          { role: "user", payload: { text: "Survive the restart" } },
          {
            role: "assistant",
            payload: { text: "Echo: Survive the restart" },
          },
        ]);
      } finally {
        await restartedApp.close();
      }
    } finally {
      if (!firstAppClosed) {
        await firstApp.close().catch(() => undefined);
      }
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("session REST API", () => {
  it("creates, lists, and retrieves a session", async () => {
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "  REST conversation  " },
    });

    expect(createdResponse.statusCode).toBe(201);
    expect(createdResponse.headers.location).toMatch(/^\/api\/sessions\//);
    const { session } = SessionResponseSchema.parse(createdResponse.json());
    expect(session.title).toBe("REST conversation");

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/sessions",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(
      SessionListResponseSchema.parse(listResponse.json()).sessions,
    ).toContainEqual(session);

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(SessionResponseSchema.parse(getResponse.json()).session).toEqual(
      session,
    );

    const messagesResponse = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages`,
    });
    expect(messagesResponse.statusCode).toBe(200);
    expect(
      MessageListResponseSchema.parse(messagesResponse.json()).messages,
    ).toEqual([]);
  });

  it("returns structured validation errors for invalid input", async () => {
    const invalidBody = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "   ", unexpected: true },
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(ErrorResponseSchema.parse(invalidBody.json()).error.code).toBe(
      "VALIDATION_ERROR",
    );

    const invalidId = await app.inject({
      method: "GET",
      url: "/api/sessions/not-a-uuid",
    });
    expect(invalidId.statusCode).toBe(400);
    expect(ErrorResponseSchema.parse(invalidId.json()).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("returns a structured 404 for a missing session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/0f37e589-4ac4-4a79-8061-bae31a9c4cf7/messages",
    });

    expect(response.statusCode).toBe(404);
    expect(ErrorResponseSchema.parse(response.json()).error.code).toBe(
      "SESSION_NOT_FOUND",
    );
  });
});
