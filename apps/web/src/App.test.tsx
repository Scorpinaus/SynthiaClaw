import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const fetchMock = vi.fn<typeof fetch>();
const session = {
  id: "0f37e589-4ac4-4a79-8061-bae31a9c4cf7",
  title: "Persistent conversation",
  createdAt: "2026-07-29T12:00:00.000Z",
  updatedAt: "2026-07-29T12:01:00.000Z",
};
const userMessage = {
  id: "b27c89d9-05ca-4ec3-8f61-2c74879c784b",
  sessionId: session.id,
  role: "user" as const,
  payload: { text: "Persisted hello" },
  createdAt: "2026-07-29T12:00:30.000Z",
};
const assistantMessage = {
  id: "4729724c-4a61-4aca-89d4-65ec98cc669a",
  sessionId: session.id,
  role: "assistant" as const,
  payload: { text: "Persisted response" },
  createdAt: "2026-07-29T12:01:00.000Z",
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(url: string | URL) {
    this.url = url.toString();
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  serverMessage(payload: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function healthResponse() {
  return jsonResponse({
    status: "ok",
    service: "synthia-server",
    timestamp: "2026-07-29T12:00:00.000Z",
  });
}

afterEach(() => {
  fetchMock.mockReset();
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("SynthiaClaw chat workspace", () => {
  it("starts ChatGPT OAuth when the Codex subscription provider is selected", async () => {
    const openMock = vi.fn();
    fetchMock.mockImplementation(async (input, init) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions") return jsonResponse({ sessions: [] });
      if (url === "/api/provider" && !init?.method) {
        return jsonResponse({
          mode: "codex-subscription",
          ready: false,
          account: null,
        });
      }
      if (
        url === "/api/provider/codex/login" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          loginId: "019c1234-5678-7abc-8def-0123456789ab",
          authUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("open", openMock);
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByText("ChatGPT subscription not connected"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Connect ChatGPT subscription" }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/provider/codex/login",
      expect.objectContaining({ method: "POST" }),
    );
    expect(openMock).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?state=opaque",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("loads persisted sessions and message history", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions") return jsonResponse({ sessions: [session] });
      if (url === `/api/sessions/${session.id}/messages`) {
        return jsonResponse({ messages: [userMessage, assistantMessage] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    render(<App />);

    expect(screen.getByText("Checking backend...")).toBeInTheDocument();
    expect(await screen.findByText("Backend connected")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Persistent conversation" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Persisted hello")).toBeInTheDocument();
    expect(screen.getByText("Persisted response")).toBeInTheDocument();

    act(() => FakeWebSocket.instances[0]?.open());
    expect(await screen.findByText("Chat connected")).toBeInTheDocument();
  });

  it("creates and selects a new session", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions" && init?.method === "POST") {
        return jsonResponse({ session }, 201);
      }
      if (url === "/api/sessions") return jsonResponse({ sessions: [] });
      if (url === `/api/sessions/${session.id}/messages`) {
        return jsonResponse({ messages: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("No conversations yet.")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Create new conversation" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Persistent conversation" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  });

  it("renders streamed deltas before reloading authoritative history", async () => {
    let history: unknown[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions") return jsonResponse({ sessions: [session] });
      if (url === `/api/sessions/${session.id}/messages`) {
        return jsonResponse({ messages: history });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: session.title }),
    ).toBeInTheDocument();
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => socket?.open());

    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Persisted hello",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const sent = JSON.parse(socket?.sent[0] ?? "{}") as {
      requestId: string;
    };
    expect(sent).toMatchObject({
      type: "chat.send",
      sessionId: session.id,
      text: "Persisted hello",
    });
    expect(sent.requestId).toMatch(/^req_/);

    history = [userMessage];
    act(() =>
      socket?.serverMessage({
        type: "run.started",
        requestId: sent.requestId,
        runId: "run_browser_1",
        sessionId: session.id,
      }),
    );
    expect(await screen.findByText("Persisted hello")).toBeInTheDocument();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();

    act(() =>
      socket?.serverMessage({
        type: "assistant.delta",
        requestId: sent.requestId,
        runId: "run_browser_1",
        sessionId: session.id,
        delta: "Persisted ",
      }),
    );
    expect(await screen.findByText("Persisted")).toBeInTheDocument();
    act(() =>
      socket?.serverMessage({
        type: "assistant.delta",
        requestId: sent.requestId,
        runId: "run_browser_1",
        sessionId: session.id,
        delta: "response",
      }),
    );
    expect(await screen.findByText("Persisted response")).toBeInTheDocument();

    history = [userMessage, assistantMessage];
    act(() =>
      socket?.serverMessage({
        type: "assistant.completed",
        requestId: sent.requestId,
        runId: "run_browser_1",
        sessionId: session.id,
        message: assistantMessage,
      }),
    );
    expect(await screen.findByText("Persisted response")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Thinking…")).not.toBeInTheDocument(),
    );
  });

  it("displays tool calls and results between the user message and final response", async () => {
    let history: unknown[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions") return jsonResponse({ sessions: [session] });
      if (url === `/api/sessions/${session.id}/messages`) {
        return jsonResponse({ messages: history });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: session.title });
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "What time is it?",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const request = JSON.parse(socket?.sent[0] ?? "{}") as {
      requestId: string;
    };
    const runId = "run_tools_browser_1";
    history = [
      {
        ...userMessage,
        payload: { text: "What time is it?" },
      },
    ];

    act(() =>
      socket?.serverMessage({
        type: "run.started",
        requestId: request.requestId,
        runId,
        sessionId: session.id,
      }),
    );
    act(() =>
      socket?.serverMessage({
        type: "tool.call",
        requestId: request.requestId,
        runId,
        sessionId: session.id,
        callId: "call_time_1",
        toolName: "current_time",
        arguments: {},
      }),
    );
    expect(await screen.findByText("Calling current_time")).toBeInTheDocument();

    act(() =>
      socket?.serverMessage({
        type: "tool.result",
        requestId: request.requestId,
        runId,
        sessionId: session.id,
        callId: "call_time_1",
        toolName: "current_time",
        output: '{"iso":"2026-07-30T12:34:56.000Z"}',
        isError: false,
      }),
    );
    expect(await screen.findByText("Tool completed")).toBeInTheDocument();
    expect(
      screen.getByText('{"iso":"2026-07-30T12:34:56.000Z"}'),
    ).toBeInTheDocument();

    act(() =>
      socket?.serverMessage({
        type: "assistant.delta",
        requestId: request.requestId,
        runId,
        sessionId: session.id,
        delta: "It is 12:34 UTC.",
      }),
    );
    expect(await screen.findByText("It is 12:34 UTC.")).toBeInTheDocument();
  });

  it("shows an indicator when the remember tool updates memory", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions") return jsonResponse({ sessions: [session] });
      if (url === `/api/sessions/${session.id}/messages`) {
        return jsonResponse({ messages: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: session.title });
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Remember that I prefer dark mode.",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const request = JSON.parse(socket?.sent[0] ?? "{}") as {
      requestId: string;
    };
    const runId = "run_remember_browser_1";

    act(() =>
      socket?.serverMessage({
        type: "run.started",
        requestId: request.requestId,
        runId,
        sessionId: session.id,
      }),
    );
    act(() =>
      socket?.serverMessage({
        type: "tool.call",
        requestId: request.requestId,
        runId,
        sessionId: session.id,
        callId: "call_remember_1",
        toolName: "remember",
        arguments: { memory: "The user prefers dark mode." },
      }),
    );
    act(() =>
      socket?.serverMessage({
        type: "tool.result",
        requestId: request.requestId,
        runId,
        sessionId: session.id,
        callId: "call_remember_1",
        toolName: "remember",
        output:
          '{"path":"MEMORY.md","memory":"The user prefers dark mode.","updated":true}',
        isError: false,
      }),
    );

    expect(await screen.findByText("Memory updated")).toBeInTheDocument();
  });

  it("sends run cancellation and clears the transient assistant response", async () => {
    let history: unknown[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions") return jsonResponse({ sessions: [session] });
      if (url === `/api/sessions/${session.id}/messages`) {
        return jsonResponse({ messages: history });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: session.title });
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Stop this",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const request = JSON.parse(socket?.sent[0] ?? "{}") as {
      requestId: string;
    };
    history = [
      {
        ...userMessage,
        payload: { text: "Stop this" },
      },
    ];
    act(() =>
      socket?.serverMessage({
        type: "run.started",
        requestId: request.requestId,
        runId: "run_cancel_browser_1",
        sessionId: session.id,
      }),
    );
    act(() =>
      socket?.serverMessage({
        type: "assistant.delta",
        requestId: request.requestId,
        runId: "run_cancel_browser_1",
        sessionId: session.id,
        delta: "Transient answer",
      }),
    );
    expect(await screen.findByText("Transient answer")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Stop generating" }),
    );
    expect(JSON.parse(socket?.sent[1] ?? "{}")).toEqual({
      type: "run.cancel",
      requestId: request.requestId,
      runId: "run_cancel_browser_1",
      sessionId: session.id,
    });
    act(() =>
      socket?.serverMessage({
        type: "run.cancelled",
        requestId: request.requestId,
        runId: "run_cancel_browser_1",
        sessionId: session.id,
      }),
    );

    expect(await screen.findByText("Response cancelled.")).toBeInTheDocument();
    expect(screen.queryByText("Transient answer")).not.toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Try again",
    );
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).not.toBeDisabled();
  });

  it("clears a transient response and reports an interrupted disconnect", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions") return jsonResponse({ sessions: [session] });
      if (url === `/api/sessions/${session.id}/messages`) {
        return jsonResponse({ messages: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: session.title });
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Disconnect",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const request = JSON.parse(socket?.sent[0] ?? "{}") as {
      requestId: string;
    };
    act(() =>
      socket?.serverMessage({
        type: "run.started",
        requestId: request.requestId,
        runId: "run_disconnect_browser_1",
        sessionId: session.id,
      }),
    );
    act(() =>
      socket?.serverMessage({
        type: "assistant.delta",
        requestId: request.requestId,
        runId: "run_disconnect_browser_1",
        sessionId: session.id,
        delta: "Unfinished answer",
      }),
    );
    expect(await screen.findByText("Unfinished answer")).toBeInTheDocument();

    act(() => socket?.close());

    expect(
      await screen.findByText(
        "Connection lost while the response was streaming.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Unfinished answer")).not.toBeInTheDocument();
  });

  it("shows failed and disconnected states without leaving the run locked", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = input.toString();
      if (url === "/api/health") return healthResponse();
      if (url === "/api/sessions") return jsonResponse({ sessions: [session] });
      if (url === `/api/sessions/${session.id}/messages`) {
        return jsonResponse({ messages: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: session.title });
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());

    await user.type(screen.getByRole("textbox", { name: "Message" }), "Fail");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const request = JSON.parse(socket?.sent[0] ?? "{}") as {
      requestId: string;
    };
    act(() =>
      socket?.serverMessage({
        type: "run.failed",
        requestId: request.requestId,
        runId: "run_failure_1",
        sessionId: session.id,
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message: "Configure the backend provider.",
        },
      }),
    );

    expect(
      await screen.findByText("Configure the backend provider."),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Try again",
    );
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).not.toBeDisabled();

    act(() => socket?.close());
    expect(await screen.findByText("Chat disconnected")).toBeInTheDocument();
  });
});
