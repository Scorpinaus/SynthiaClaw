import { describe, expect, it } from "vitest";

import { readServerConfig } from "./config.js";

describe("server configuration", () => {
  it("binds to loopback and trusts only the local frontend by default", () => {
    expect(readServerConfig({})).toEqual({
      host: "127.0.0.1",
      port: 3001,
      frontendOrigin: "http://127.0.0.1:5173",
    });
  });

  it("rejects invalid ports and frontend origins", () => {
    expect(() => readServerConfig({ PORT: "70000" })).toThrow(
      "PORT must be an integer between 1 and 65535.",
    );
    expect(() => readServerConfig({ PORT: "3001junk" })).toThrow(
      "PORT must be an integer between 1 and 65535.",
    );
    expect(() =>
      readServerConfig({ FRONTEND_ORIGIN: "http://127.0.0.1:5173/path" }),
    ).toThrow("FRONTEND_ORIGIN must be an HTTP(S) origin without a path.");
  });
});
