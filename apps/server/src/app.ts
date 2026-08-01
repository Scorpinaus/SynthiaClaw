import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import websocket from "@fastify/websocket";
import {
  AssistantCompletedEventSchema,
  AssistantDeltaEventSchema,
  ClientWebSocketEventSchema,
  CodexLoginResponseSchema,
  CreateSessionRequestSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  MessageListResponseSchema,
  ProviderStatusResponseSchema,
  RunCancelledEventSchema,
  RunFailedEventSchema,
  RunStartedEventSchema,
  ServerWebSocketEventSchema,
  SessionListResponseSchema,
  SessionParamsSchema,
  SessionResponseSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  type ServerWebSocketEvent,
} from "@synthia/shared";
import Fastify, { type FastifyServerOptions } from "fastify";

import { runAgentLoop } from "./agentLoop.js";
import { normalizeFrontendOrigin } from "./config.js";
import { buildAgentContext } from "./identity.js";
import {
  ProviderError,
  type ModelProvider,
  type ProviderRuntime,
} from "./provider.js";
import { createProviderRuntimeFromEnv } from "./providerRuntime.js";
import { ChatRepository, RepositoryError } from "./repository.js";
import { redactCredentials } from "./security.js";
import { createToolRegistry } from "./tools.js";

export interface AppDependencies {
  databasePath?: string;
  provider?: ModelProvider;
  providerRuntime?: ProviderRuntime;
  repository?: ChatRepository;
  frontendOrigin?: string;
  agent?: {
    workspaceRoot: string;
    maxContextChars?: number;
    maxIterations: number;
    timeoutMs: number;
    now?: () => Date;
  };
}

export function buildApp(
  options: FastifyServerOptions = {},
  dependencies: AppDependencies = {},
) {
  const app = Fastify(options);
  app.register(websocket);
  const repository =
    dependencies.repository ??
    new ChatRepository(
      dependencies.databasePath ??
        process.env.DATABASE_PATH ??
        resolve("data", "synthia.sqlite"),
    );
  let runtime: ProviderRuntime;
  if (dependencies.providerRuntime) {
    runtime = dependencies.providerRuntime;
  } else if (dependencies.provider) {
    runtime = {
      mode: "openai-api",
      provider: dependencies.provider,
      close: async () => {},
    };
  } else {
    try {
      runtime = createProviderRuntimeFromEnv();
    } catch (error) {
      const configurationError =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              "PROVIDER_NOT_CONFIGURED",
              "The model provider is not configured.",
            );
      runtime = {
        mode: "openai-api",
        provider: null,
        configurationError,
        close: async () => {},
      };
    }
  }
  const provider = runtime.provider;
  const providerConfigurationError = runtime.configurationError ?? null;
  const frontendOrigin = normalizeFrontendOrigin(
    dependencies.frontendOrigin ??
      process.env.FRONTEND_ORIGIN ??
      "http://127.0.0.1:5173",
  );
  const agent = {
    workspaceRoot:
      dependencies.agent?.workspaceRoot ??
      process.env.TOOL_WORKSPACE_ROOT ??
      process.env.CODEX_WORKING_DIRECTORY ??
      process.cwd(),
    maxIterations:
      dependencies.agent?.maxIterations ??
      readPositiveInteger(process.env.AGENT_MAX_ITERATIONS, 8),
    maxContextChars:
      dependencies.agent?.maxContextChars ??
      readPositiveInteger(process.env.AGENT_CONTEXT_MAX_CHARS, 60_000),
    timeoutMs:
      dependencies.agent?.timeoutMs ??
      readPositiveInteger(process.env.AGENT_TIMEOUT_MS, 30_000),
  };
  const toolRegistry = createToolRegistry({
    workspaceRoot: agent.workspaceRoot,
    now: dependencies.agent?.now,
  });

  const errorBody = (code: string, message: string) =>
    ErrorResponseSchema.parse({
      error: { code, message: redactCredentials(message) },
    });

  const providerErrorReply = (
    reply: { code(statusCode: number): { send(payload: unknown): unknown } },
    error: unknown,
  ) => {
    const detail =
      error instanceof ProviderError
        ? { code: error.code, message: error.message }
        : {
            code: "CODEX_REQUEST_FAILED",
            message: "Codex could not complete the provider request.",
          };
    return reply.code(503).send(errorBody(detail.code, detail.message));
  };

  app.addHook("onClose", async () => {
    try {
      await runtime.close();
    } finally {
      repository.close();
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    const isWebSocketUpgrade =
      request.headers.upgrade?.toLowerCase() === "websocket";
    if (
      (isWebSocketUpgrade && requestOrigin === undefined) ||
      (requestOrigin !== undefined && requestOrigin !== frontendOrigin)
    ) {
      return reply
        .code(403)
        .send(
          errorBody(
            "ORIGIN_NOT_ALLOWED",
            "The request origin is not allowed.",
          ),
        );
    }
  });

  app.get("/api/health", async () =>
    HealthResponseSchema.parse({
      status: "ok",
      service: "synthia-server",
      timestamp: new Date().toISOString(),
    }),
  );

  app.get("/api/provider", async (_request, reply) => {
    if (runtime.mode === "openai-api") {
      return ProviderStatusResponseSchema.parse({
        mode: runtime.mode,
        ready: runtime.provider !== null,
        account: null,
      });
    }
    if (!runtime.accountManager) {
      return reply
        .code(503)
        .send(
          errorBody(
            "CODEX_PROVIDER_UNAVAILABLE",
            "The Codex account manager is unavailable.",
          ),
        );
    }
    try {
      return ProviderStatusResponseSchema.parse(
        await runtime.accountManager.getSubscriptionStatus(),
      );
    } catch (error) {
      return providerErrorReply(reply, error);
    }
  });

  app.post("/api/provider/codex/login", async (_request, reply) => {
    if (runtime.mode !== "codex-subscription" || !runtime.accountManager) {
      return reply
        .code(409)
        .send(
          errorBody(
            "CODEX_PROVIDER_DISABLED",
            "Select the Codex subscription provider before starting OAuth.",
          ),
        );
    }
    try {
      return CodexLoginResponseSchema.parse(
        await runtime.accountManager.startChatGptLogin(),
      );
    } catch (error) {
      return providerErrorReply(reply, error);
    }
  });

  app.post("/api/provider/codex/logout", async (_request, reply) => {
    if (runtime.mode !== "codex-subscription" || !runtime.accountManager) {
      return reply
        .code(409)
        .send(
          errorBody(
            "CODEX_PROVIDER_DISABLED",
            "The Codex subscription provider is not selected.",
          ),
        );
    }
    try {
      await runtime.accountManager.logout();
      return reply.code(204).send();
    } catch (error) {
      return providerErrorReply(reply, error);
    }
  });

  app.get("/api/sessions", async () =>
    SessionListResponseSchema.parse({
      sessions: repository.listSessions(),
    }),
  );

  app.post("/api/sessions", async (request, reply) => {
    const parsed = CreateSessionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorBody(
            "VALIDATION_ERROR",
            "The session request body is invalid.",
          ),
        );
    }

    const session = repository.createSession(parsed.data.title);
    return reply
      .code(201)
      .header("Location", `/api/sessions/${session.id}`)
      .send(SessionResponseSchema.parse({ session }));
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const parsed = SessionParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorBody("VALIDATION_ERROR", "The session identifier is invalid."),
        );
    }

    const session = repository.getSession(parsed.data.id);
    if (!session) {
      return reply
        .code(404)
        .send(
          errorBody("SESSION_NOT_FOUND", "The requested session was not found."),
        );
    }

    return SessionResponseSchema.parse({ session });
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const parsed = SessionParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorBody("VALIDATION_ERROR", "The session identifier is invalid."),
        );
    }

    if (!repository.getSession(parsed.data.id)) {
      return reply
        .code(404)
        .send(
          errorBody("SESSION_NOT_FOUND", "The requested session was not found."),
        );
    }

    return MessageListResponseSchema.parse({
      messages: repository.listMessages(parsed.data.id),
    });
  });

  app.register(async (chatApp) => {
    chatApp.get("/api/chat", { websocket: true }, (socket) => {
      type ActiveRun = {
        requestId: string;
        runId: string;
        sessionId: string;
        controller: AbortController;
        cancelled: boolean;
        cancelNotified: boolean;
        timedOut: boolean;
        timeout: NodeJS.Timeout | null;
      };
      const activeRuns = new Map<string, ActiveRun>();

      const send = (event: ServerWebSocketEvent): boolean => {
        if (socket.readyState !== 1) return false;
        try {
          socket.send(JSON.stringify(ServerWebSocketEventSchema.parse(event)));
          return true;
        } catch {
          return false;
        }
      };

      const cancelActiveRun = (active: ActiveRun, notify: boolean) => {
        if (active.cancelled) return;
        active.cancelled = true;
        activeRuns.delete(active.runId);
        if (active.timeout) clearTimeout(active.timeout);
        repository.cancelRun(active.requestId);
        active.controller.abort();
        if (notify) {
          active.cancelNotified = true;
          send(
            RunCancelledEventSchema.parse({
              type: "run.cancelled",
              requestId: active.requestId,
              runId: active.runId,
              sessionId: active.sessionId,
            }),
          );
        }
      };

      socket.on("close", () => {
        for (const active of [...activeRuns.values()]) {
          cancelActiveRun(active, false);
        }
      });

      socket.on("message", async (rawData: { toString(): string }) => {
        let input: unknown;
        try {
          input = JSON.parse(rawData.toString()) as unknown;
        } catch {
          input = null;
        }

        const generatedRunId = `run_${randomUUID().replaceAll("-", "")}`;
        const parsed = ClientWebSocketEventSchema.safeParse(input);
        if (!parsed.success) {
          const fallback = getFailureIdentifiers(input);
          send(
            RunFailedEventSchema.parse({
              type: "run.failed",
              requestId: fallback.requestId,
              runId: generatedRunId,
              sessionId: fallback.sessionId,
              error: {
                code: "VALIDATION_ERROR",
                message: "The WebSocket message is invalid.",
              },
            }),
          );
          return;
        }

        const event = parsed.data;
        if (event.type === "run.cancel") {
          const active = activeRuns.get(event.runId);
          if (
            !active ||
            active.requestId !== event.requestId ||
            active.sessionId !== event.sessionId
          ) {
            send(
              RunFailedEventSchema.parse({
                type: "run.failed",
                requestId: event.requestId,
                runId: event.runId,
                sessionId: event.sessionId,
                error: {
                  code: "RUN_NOT_ACTIVE",
                  message: "The run is no longer active.",
                },
              }),
            );
            return;
          }
          cancelActiveRun(active, true);
          return;
        }

        let start;
        try {
          start = repository.startRun({
            requestId: event.requestId,
            runId: generatedRunId,
            sessionId: event.sessionId,
            text: event.text,
          });
        } catch (error) {
          const detail =
            error instanceof RepositoryError
              ? { code: error.code, message: error.message }
              : {
                  code: "PERSISTENCE_ERROR",
                  message: "The chat request could not be persisted.",
                };
          send(
            RunFailedEventSchema.parse({
              type: "run.failed",
              requestId: event.requestId,
              runId: generatedRunId,
              sessionId: event.sessionId,
              error: detail,
            }),
          );
          return;
        }

        if (start.status !== "started") {
          send(
            RunStartedEventSchema.parse({
              type: "run.started",
              requestId: event.requestId,
              runId: start.runId,
              sessionId: event.sessionId,
            }),
          );
          if (start.status === "completed") {
            send(
              AssistantCompletedEventSchema.parse({
                type: "assistant.completed",
                requestId: event.requestId,
                runId: start.runId,
                sessionId: event.sessionId,
                message: start.assistantMessage,
              }),
            );
          } else if (
            start.status === "failed" &&
            start.error.code === "RUN_CANCELLED"
          ) {
            send(
              RunCancelledEventSchema.parse({
                type: "run.cancelled",
                requestId: event.requestId,
                runId: start.runId,
                sessionId: event.sessionId,
              }),
            );
          } else {
            const error =
              start.status === "failed"
                ? start.error
                : {
                    code: "REQUEST_IN_PROGRESS",
                    message: "This request is already running.",
                  };
            send(
              RunFailedEventSchema.parse({
                type: "run.failed",
                requestId: event.requestId,
                runId: start.runId,
                sessionId: event.sessionId,
                error,
              }),
            );
          }
          return;
        }

        const controller = new AbortController();
        const active: ActiveRun = {
          requestId: event.requestId,
          runId: start.runId,
          sessionId: event.sessionId,
          controller,
          cancelled: false,
          cancelNotified: false,
          timedOut: false,
          timeout: null,
        };
        active.timeout = setTimeout(() => {
          active.timedOut = true;
          controller.abort();
        }, agent.timeoutMs);
        active.timeout.unref();
        activeRuns.set(active.runId, active);
        if (
          !send(
            RunStartedEventSchema.parse({
              type: "run.started",
              requestId: event.requestId,
              runId: start.runId,
              sessionId: event.sessionId,
            }),
          )
        ) {
          cancelActiveRun(active, false);
          return;
        }

        try {
          if (!provider) {
            throw (
              providerConfigurationError ??
              new ProviderError(
                "PROVIDER_NOT_CONFIGURED",
                "The model provider is not configured.",
              )
            );
          }

          const messages = await buildAgentContext({
            workspaceRoot: agent.workspaceRoot,
            maxChars: agent.maxContextChars,
            messages: repository
              .listMessages(event.sessionId)
              .map((message) => ({
                role: message.role,
                content: message.payload.text,
              })),
          });
          const responseText = await runAgentLoop({
            provider,
            messages,
            tools: toolRegistry,
            signal: active.controller.signal,
            maxIterations: agent.maxIterations,
            onDelta: (delta) => {
              send(
                AssistantDeltaEventSchema.parse({
                  type: "assistant.delta",
                  requestId: event.requestId,
                  runId: start.runId,
                  sessionId: event.sessionId,
                  delta,
                }),
              );
            },
            onToolCall: (call) => {
              send(
                ToolCallEventSchema.parse({
                  type: "tool.call",
                  requestId: event.requestId,
                  runId: start.runId,
                  sessionId: event.sessionId,
                  callId: call.callId,
                  toolName: call.toolName,
                  arguments: call.arguments,
                }),
              );
            },
            onToolResult: (call, output, isError) => {
              send(
                ToolResultEventSchema.parse({
                  type: "tool.result",
                  requestId: event.requestId,
                  runId: start.runId,
                  sessionId: event.sessionId,
                  callId: call.callId,
                  toolName: call.toolName,
                  output: isError ? redactCredentials(output) : output,
                  isError,
                }),
              );
            },
          });
          if (active.timedOut) {
            throw new ProviderError(
              "AGENT_TIMEOUT",
              `The agent run exceeded its ${agent.timeoutMs} ms timeout.`,
            );
          }
          if (active.cancelled || active.controller.signal.aborted) return;

          const message = repository.completeRun(
            event.requestId,
            responseText,
          );
          activeRuns.delete(active.runId);
          if (active.timeout) clearTimeout(active.timeout);
          send(
            AssistantCompletedEventSchema.parse({
              type: "assistant.completed",
              requestId: event.requestId,
              runId: start.runId,
              sessionId: event.sessionId,
              message,
            }),
          );
        } catch (error) {
          activeRuns.delete(active.runId);
          if (active.timeout) clearTimeout(active.timeout);
          if (
            !active.timedOut &&
            (active.cancelled || active.controller.signal.aborted)
          ) {
            repository.cancelRun(event.requestId);
            if (!active.cancelNotified) {
              active.cancelNotified = true;
              send(
                RunCancelledEventSchema.parse({
                  type: "run.cancelled",
                  requestId: event.requestId,
                  runId: start.runId,
                  sessionId: event.sessionId,
                }),
              );
            }
            return;
          }

          const unsafeDetail =
            active.timedOut
              ? {
                  code: "AGENT_TIMEOUT",
                  message: `The agent run exceeded its ${agent.timeoutMs} ms timeout.`,
                }
              : error instanceof ProviderError
              ? { code: error.code, message: error.message }
              : {
                  code: "PROVIDER_FAILED",
                  message:
                    "The model provider could not complete the request.",
                };
          const detail = {
            ...unsafeDetail,
            message: redactCredentials(unsafeDetail.message),
          };
          repository.failRun(event.requestId, detail);
          send(
            RunFailedEventSchema.parse({
              type: "run.failed",
              requestId: event.requestId,
              runId: start.runId,
              sessionId: event.sessionId,
              error: detail,
            }),
          );
        }
      });
    });
  });

  return app;
}

function getFailureIdentifiers(input: unknown): {
  requestId: string;
  sessionId: string;
} {
  const record =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const requestId =
    typeof record.requestId === "string" &&
    /^req_[A-Za-z0-9_-]+$/.test(record.requestId)
      ? record.requestId
      : `req_invalid_${randomUUID().replaceAll("-", "")}`;
  const sessionIdResult = SessionParamsSchema.safeParse({
    id: record.sessionId,
  });
  return {
    requestId,
    sessionId: sessionIdResult.success
      ? sessionIdResult.data.id
      : randomUUID(),
  };
}

function readPositiveInteger(
  rawValue: string | undefined,
  fallback: number,
): number {
  if (rawValue === undefined) return fallback;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
