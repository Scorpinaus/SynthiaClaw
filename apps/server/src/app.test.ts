import { mkdtempSync, rmSync } from "node:fs";
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

const complete = vi.fn<ModelProvider["complete"]>(async (messages) => {
  const latest = messages.at(-1);
  return `Echo: ${latest?.content ?? ""}`;
});
const app = buildApp(
  { logger: false },
  { databasePath: ":memory:", provider: { complete } },
);

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  complete.mockClear();
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
      provider: { complete },
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
  it("persists one user message and one complete assistant response", async () => {
    const session = await createSession("WebSocket chat");
    const socket = await app.injectWS("/api/chat");
    const eventsPromise = new Promise<ServerWebSocketEvent[]>(
      (resolve, reject) => {
        const events: ServerWebSocketEvent[] = [];
        socket.on("error", reject);
        socket.on("message", (data) => {
          events.push(ServerWebSocketEventSchema.parse(JSON.parse(data.toString())));
          if (events.length === 2) {
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
      type: "assistant.completed",
      requestId: "req_ws_1",
      sessionId: session.id,
      message: {
        role: "assistant",
        payload: { text: "Echo: Hello over WebSocket" },
      },
    });
    expect(complete).toHaveBeenCalledWith([
      { role: "user", content: "Hello over WebSocket" },
    ]);

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

    const receiveLifecycle = () =>
      new Promise<ServerWebSocketEvent[]>((resolve, reject) => {
        const events: ServerWebSocketEvent[] = [];
        const onMessage = (data: { toString(): string }) => {
          events.push(
            ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
          );
          if (events.length === 2) {
            socket.off("message", onMessage);
            resolve(events);
          }
        };
        socket.once("error", reject);
        socket.on("message", onMessage);
      });

    const firstLifecycle = receiveLifecycle();
    socket.send(JSON.stringify(payload));
    await firstLifecycle;
    const replayLifecycle = receiveLifecycle();
    socket.send(JSON.stringify(payload));
    const replay = await replayLifecycle;
    socket.close();

    expect(replay.map((event) => event.type)).toEqual([
      "run.started",
      "assistant.completed",
    ]);
    expect(complete).toHaveBeenCalledTimes(1);

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
    expect(complete).not.toHaveBeenCalled();
  });

  it("releases the session lock when the provider fails", async () => {
    const session = await createSession("Provider failure");
    complete.mockRejectedValueOnce(new Error("provider offline"));
    const socket = await app.injectWS("/api/chat");

    const receiveLifecycle = () =>
      new Promise<ServerWebSocketEvent[]>((resolve, reject) => {
        const events: ServerWebSocketEvent[] = [];
        const onMessage = (data: { toString(): string }) => {
          events.push(
            ServerWebSocketEventSchema.parse(JSON.parse(data.toString())),
          );
          if (events.length === 2) {
            socket.off("message", onMessage);
            resolve(events);
          }
        };
        socket.once("error", reject);
        socket.on("message", onMessage);
      });

    const failedLifecycle = receiveLifecycle();
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

    const completedLifecycle = receiveLifecycle();
    socket.send(
      JSON.stringify({
        type: "chat.send",
        requestId: "req_after_failure_1",
        sessionId: session.id,
        text: "Try again",
      }),
    );
    expect((await completedLifecycle)[1]?.type).toBe("assistant.completed");
    socket.close();
  });
});

describe("conversation persistence", () => {
  it("serves the complete conversation after a backend restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synthia-app-restart-"));
    const databasePath = join(directory, "chat.sqlite");
    const firstApp = buildApp(
      { logger: false },
      { databasePath, provider: { complete } },
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
        { databasePath, provider: { complete } },
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
