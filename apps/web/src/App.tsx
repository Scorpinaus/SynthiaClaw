import { HealthResponseSchema, type HealthResponse } from "@synthia/shared";
import { useCallback, useEffect, useRef, useState } from "react";

type ConnectionState = "checking" | "connected" | "unavailable";

const connectionCopy: Record<ConnectionState, string> = {
  checking: "Checking backend...",
  connected: "Backend connected",
  unavailable: "Backend unavailable",
};

export function App() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("checking");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

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

  useEffect(() => {
    void checkBackend();
    const interval = window.setInterval(() => {
      void checkBackend();
    }, 15_000);

    return () => {
      window.clearInterval(interval);
      activeRequest.current?.abort();
    };
  }, [checkBackend]);

  return (
    <main className="shell">
      <section className="status-card" aria-labelledby="app-title">
        <p className="eyebrow">Milestone 1</p>
        <h1 id="app-title">SynthiaClaw</h1>
        <p className="intro">
          The local control surface for your personal agent.
        </p>

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
                : "Waiting for the local API at /api/health."}
            </p>
          </div>
        </div>

        {connectionState === "unavailable" ? (
          <button type="button" onClick={() => void checkBackend()}>
            Retry connection
          </button>
        ) : null}
      </section>
    </main>
  );
}
