import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("App backend status", () => {
  it("displays a live connected status when the health endpoint succeeds", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          service: "synthia-server",
          timestamp: "2026-07-29T12:00:00.000Z",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(screen.getByText("Checking backend...")).toBeInTheDocument();
    expect(await screen.findByText("Backend connected")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("shows a disconnected state and can retry", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ok",
            service: "synthia-server",
            timestamp: "2026-07-29T12:00:00.000Z",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("Backend unavailable")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByText("Backend connected")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a response that violates the shared health schema", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "maybe" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByText("Backend unavailable")).toBeInTheDocument();
  });
});
