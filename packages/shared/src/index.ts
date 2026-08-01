import { z } from "zod";

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("synthia-server"),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const RequestIdSchema = z
  .string()
  .min(5)
  .max(128)
  .regex(/^req_[A-Za-z0-9_-]+$/);
const RunIdSchema = z
  .string()
  .min(5)
  .max(128)
  .regex(/^run_[A-Za-z0-9_-]+$/);
const ToolCallIdSchema = z.string().min(1).max(128);

export const SessionSchema = z
  .object({
    id: UuidSchema,
    title: z.string().min(1).max(120),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const MessagePayloadSchema = z
  .object({
    text: z.string().min(1).max(100_000),
  })
  .strict();

export const MessageSchema = z
  .object({
    id: UuidSchema,
    sessionId: UuidSchema,
    role: z.enum(["user", "assistant"]),
    payload: MessagePayloadSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const CreateSessionRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const SessionParamsSchema = z
  .object({
    id: UuidSchema,
  })
  .strict();

export const SessionListResponseSchema = z
  .object({
    sessions: z.array(SessionSchema),
  })
  .strict();

export const SessionResponseSchema = z
  .object({
    session: SessionSchema,
  })
  .strict();

export const MessageListResponseSchema = z
  .object({
    messages: z.array(MessageSchema),
  })
  .strict();

export const ErrorDetailSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const ErrorResponseSchema = z
  .object({
    error: ErrorDetailSchema,
  })
  .strict();

export const ProviderModeSchema = z.enum([
  "openai-api",
  "ollama",
  "codex-subscription",
]);

export const CodexPlanTypeSchema = z.enum([
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

export const CodexAccountSchema = z
  .object({
    email: z.string().email().nullable(),
    planType: CodexPlanTypeSchema,
  })
  .strict();

export const ProviderStatusResponseSchema = z
  .object({
    mode: ProviderModeSchema,
    ready: z.boolean(),
    account: CodexAccountSchema.nullable(),
  })
  .strict();

export const CodexLoginResponseSchema = z
  .object({
    loginId: z.string().min(1),
    authUrl: z.string().url(),
  })
  .strict();

export const ChatSendEventSchema = z
  .object({
    type: z.literal("chat.send"),
    requestId: RequestIdSchema,
    sessionId: UuidSchema,
    text: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const ChatCancelEventSchema = z
  .object({
    type: z.literal("run.cancel"),
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    sessionId: UuidSchema,
  })
  .strict();

export const RunStartedEventSchema = z
  .object({
    type: z.literal("run.started"),
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    sessionId: UuidSchema,
  })
  .strict();

export const AssistantDeltaEventSchema = z
  .object({
    type: z.literal("assistant.delta"),
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    sessionId: UuidSchema,
    delta: z.string().min(1).max(100_000),
  })
  .strict();

export const ToolCallEventSchema = z
  .object({
    type: z.literal("tool.call"),
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    sessionId: UuidSchema,
    callId: ToolCallIdSchema,
    toolName: z.string().min(1).max(128),
    arguments: z.record(z.unknown()),
  })
  .strict();

export const ToolResultEventSchema = z
  .object({
    type: z.literal("tool.result"),
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    sessionId: UuidSchema,
    callId: ToolCallIdSchema,
    toolName: z.string().min(1).max(128),
    output: z.string().max(200_000),
    isError: z.boolean(),
  })
  .strict();

export const AssistantCompletedEventSchema = z
  .object({
    type: z.literal("assistant.completed"),
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    sessionId: UuidSchema,
    message: MessageSchema,
  })
  .strict();

export const RunCancelledEventSchema = z
  .object({
    type: z.literal("run.cancelled"),
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    sessionId: UuidSchema,
  })
  .strict();

export const RunFailedEventSchema = z
  .object({
    type: z.literal("run.failed"),
    requestId: RequestIdSchema,
    runId: RunIdSchema,
    sessionId: UuidSchema,
    error: ErrorDetailSchema,
  })
  .strict();

export const ClientWebSocketEventSchema = z.discriminatedUnion("type", [
  ChatSendEventSchema,
  ChatCancelEventSchema,
]);

export const ServerWebSocketEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  AssistantDeltaEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  AssistantCompletedEventSchema,
  RunCancelledEventSchema,
  RunFailedEventSchema,
]);

export type Session = z.infer<typeof SessionSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessagePayload = z.infer<typeof MessagePayloadSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;
export type ProviderMode = z.infer<typeof ProviderModeSchema>;
export type CodexPlanType = z.infer<typeof CodexPlanTypeSchema>;
export type CodexAccount = z.infer<typeof CodexAccountSchema>;
export type ProviderStatusResponse = z.infer<
  typeof ProviderStatusResponseSchema
>;
export type CodexLoginResponse = z.infer<typeof CodexLoginResponseSchema>;
export type ChatSendEvent = z.infer<typeof ChatSendEventSchema>;
export type ChatCancelEvent = z.infer<typeof ChatCancelEventSchema>;
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type AssistantDeltaEvent = z.infer<typeof AssistantDeltaEventSchema>;
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;
export type AssistantCompletedEvent = z.infer<
  typeof AssistantCompletedEventSchema
>;
export type RunCancelledEvent = z.infer<typeof RunCancelledEventSchema>;
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;
export type ClientWebSocketEvent = z.infer<typeof ClientWebSocketEventSchema>;
export type ServerWebSocketEvent = z.infer<typeof ServerWebSocketEventSchema>;
