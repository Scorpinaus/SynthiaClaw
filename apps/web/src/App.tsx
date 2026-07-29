import {
  ChatSendEventSchema,
  HealthResponseSchema,
  MessageListResponseSchema,
  ServerWebSocketEventSchema,
  SessionListResponseSchema,
  SessionResponseSchema,
  type HealthResponse,
  type Message,
  type Session,
} from "@synthia/shared";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type ConnectionState = "checking" | "connected" | "unavailable";
type SocketState = "connecting" | "connected" | "disconnected";
type HistoryState = "idle" | "loading" | "ready" | "failed";

const connectionCopy: Record<ConnectionState, string> = {
  checking: "Checking backend...",
  connected: "Backend connected",
  unavailable: "Backend unavailable",
};

const socketCopy: Record<SocketState, string> = {
  connecting: "Chat connecting…",
  connected: "Chat connected",
  disconnected: "Chat disconnected",
};

export function App() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("checking");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyState, setHistoryState] = useState<HistoryState>("idle");
  const [socketState, setSocketState] =
    useState<SocketState>("connecting");
  const [composerText, setComposerText] = useState("");
  const [running, setRunning] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const selectedSessionRef = useRef<string | null>(null);
  const historyRequestNumber = useRef(0);

  const checkBackend = useCallback(async () => {
    activeRequest.current?.abort();

    const controller = new AbortController();
    activeRequest.current = controller;
    setConnectionState("checking");

    try {
      const response = await fetch("/api/health", {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Health request failed with status ${response.status}.`);
      }

      const result = HealthResponseSchema.parse(await response.json());
      setHealth(result);
      setConnectionState("connected");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      setHealth(null);
      setConnectionState("unavailable");
    }
  }, []);

  const loadSessions = useCallback(async () => {
    const response = await fetch("/api/sessions");
    if (!response.ok) {
      throw new Error(`Session request failed with status ${response.status}.`);
    }
    const result = SessionListResponseSchema.parse(await response.json());
    setSessions(result.sessions);
    setSelectedSessionId((current) => {
      if (current && result.sessions.some((session) => session.id === current)) {
        return current;
      }
      return result.sessions[0]?.id ?? null;
    });
  }, []);

  const loadMessages = useCallback(async (sessionId: string) => {
    const requestNumber = ++historyRequestNumber.current;
    setHistoryState("loading");
    try {
      const response = await fetch(`/api/sessions/${sessionId}/messages`);
      if (!response.ok) {
        throw new Error(
          `Message request failed with status ${response.status}.`,
        );
      }
      const result = MessageListResponseSchema.parse(await response.json());
      if (
        requestNumber === historyRequestNumber.current &&
        selectedSessionRef.current === sessionId
      ) {
        setMessages(result.messages);
        setHistoryState("ready");
      }
    } catch {
      if (
        requestNumber === historyRequestNumber.current &&
        selectedSessionRef.current === sessionId
      ) {
        setHistoryState("failed");
      }
    }
  }, []);

  useEffect(() => {
    void checkBackend();
    void loadSessions().catch(() => {
      setSessions([]);
    });
    const interval = window.setInterval(() => {
      void checkBackend();
    }, 15_000);

    return () => {
      window.clearInterval(interval);
      activeRequest.current?.abort();
    };
  }, [checkBackend, loadSessions]);

  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
    setMessages([]);
    setChatError(null);
    setRunning(false);
    if (selectedSessionId) {
      void loadMessages(selectedSessionId);
    } else {
      setHistoryState("idle");
    }
  }, [loadMessages, selectedSessionId]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;
      setSocketState("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/api/chat`,
      );
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        setSocketState("connected");
        const sessionId = selectedSessionRef.current;
        if (sessionId) {
          void loadMessages(sessionId);
        }
      };
      socket.onmessage = (messageEvent) => {
        let event;
        try {
          event = ServerWebSocketEventSchema.parse(
            JSON.parse(messageEvent.data) as unknown,
          );
        } catch {
          setChatError("The backend sent an invalid chat event.");
          return;
        }

        if (event.sessionId !== selectedSessionRef.current) {
          return;
        }
        if (event.type === "run.started") {
          setRunning(true);
          setChatError(null);
          void loadMessages(event.sessionId);
          return;
        }
        if (event.type === "assistant.completed") {
          setRunning(false);
          setChatError(null);
          void loadMessages(event.sessionId);
          void loadSessions().catch(() => undefined);
          return;
        }

        setRunning(false);
        setChatError(event.error.message);
        void loadMessages(event.sessionId);
      };
      socket.onerror = () => {
        if (!disposed) {
          setSocketState("disconnected");
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setSocketState("disconnected");
        setRunning(false);
        reconnectTimer = window.setTimeout(connect, 1_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [loadMessages, loadSessions]);

  const createSession = async () => {
    setChatError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error(`Create request failed with status ${response.status}.`);
      }
      const result = SessionResponseSchema.parse(await response.json());
      setSessions((current) => [
        result.session,
        ...current.filter((session) => session.id !== result.session.id),
      ]);
      setSelectedSessionId(result.session.id);
    } catch {
      setChatError("The conversation could not be created.");
    }
  };

  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const socket = socketRef.current;
    const text = composerText.trim();
    if (
      !selectedSessionId ||
      !text ||
      running ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const request = ChatSendEventSchema.parse({
      type: "chat.send",
      requestId: `req_${crypto.randomUUID().replaceAll("-", "")}`,
      sessionId: selectedSessionId,
      text,
    });
    socket.send(JSON.stringify(request));
    setComposerText("");
    setChatError(null);
    setRunning(true);
  };

  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Conversations">
        <header className="brand">
          <p className="eyebrow">Milestone 2</p>
          <h1 id="app-title">SynthiaClaw</h1>
          <p>Persistent local chat</p>
        </header>

        <div className="connection-stack">
          <div
            className={`connection connection--${connectionState}`}
            role="status"
            aria-live="polite"
          >
            <span className="connection__indicator" aria-hidden="true" />
            <div>
              <strong>{connectionCopy[connectionState]}</strong>
              <p>
                {health
                  ? `Last response: ${new Date(health.timestamp).toLocaleTimeString()}`
                  : "Waiting for /api/health."}
              </p>
            </div>
          </div>

          <div
            className={`socket-status socket-status--${socketState}`}
            role="status"
            aria-live="polite"
          >
            <span aria-hidden="true" />
            {socketCopy[socketState]}
          </div>
        </div>

        {connectionState === "unavailable" ? (
          <button className="retry-button" type="button" onClick={() => void checkBackend()}>
            Retry backend
          </button>
        ) : null}

        <button
          className="new-session"
          type="button"
          aria-label="Create new conversation"
          onClick={() => void createSession()}
        >
          <span aria-hidden="true">＋</span> New conversation
        </button>

        <nav className="session-list" aria-label="Session history">
          {sessions.length === 0 ? (
            <p className="empty-sidebar">No conversations yet.</p>
          ) : (
            sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                aria-label={session.title}
                className={
                  session.id === selectedSessionId ? "session is-selected" : "session"
                }
                onClick={() => setSelectedSessionId(session.id)}
              >
                <span>{session.title}</span>
                <time dateTime={session.updatedAt}>
                  {new Date(session.updatedAt).toLocaleDateString()}
                </time>
              </button>
            ))
          )}
        </nav>
      </aside>

      <section className="chat-panel" aria-labelledby="conversation-title">
        {selectedSession ? (
          <>
            <header className="chat-header">
              <div>
                <p className="eyebrow">Conversation</p>
                <h2 id="conversation-title">{selectedSession.title}</h2>
              </div>
              <span className="message-count">
                {messages.length} {messages.length === 1 ? "message" : "messages"}
              </span>
            </header>

            <div className="message-list" aria-live="polite">
              {historyState === "loading" && messages.length === 0 ? (
                <p className="empty-chat">Loading messages…</p>
              ) : null}
              {historyState === "failed" ? (
                <p className="chat-error" role="alert">
                  Conversation history could not be loaded.
                </p>
              ) : null}
              {historyState === "ready" && messages.length === 0 ? (
                <p className="empty-chat">No messages yet.</p>
              ) : null}
              {messages.map((message) => (
                <article
                  className={`message message--${message.role}`}
                  key={message.id}
                >
                  <p className="message__role">
                    {message.role === "user" ? "You" : "Synthia"}
                  </p>
                  <p>{message.payload.text}</p>
                </article>
              ))}
              {running ? (
                <div className="thinking" role="status">
                  <span aria-hidden="true" />
                  Thinking…
                </div>
              ) : null}
            </div>

            <footer className="composer-area">
              {chatError ? (
                <p className="chat-error" role="alert">
                  {chatError}
                </p>
              ) : null}
              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  aria-label="Message"
                  placeholder="Message SynthiaClaw…"
                  rows={2}
                  value={composerText}
                  onChange={(event) => setComposerText(event.target.value)}
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={
                    running ||
                    socketState !== "connected" ||
                    composerText.trim().length === 0
                  }
                >
                  Send
                </button>
              </form>
            </footer>
          </>
        ) : (
          <div className="welcome-state">
            <p className="eyebrow">Ready when you are</p>
            <h2 id="conversation-title">Start a persistent conversation</h2>
            <p>
              Create a conversation to begin. Messages are stored locally and
              return after a refresh or restart.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
