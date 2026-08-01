// @vitest-environment node

import type { UserConfig } from "vite";
import { describe, expect, it } from "vitest";

import viteConfig from "../vite.config";

describe("Vite development proxy", () => {
  it("forwards API requests to the local backend", () => {
    const config = viteConfig as UserConfig;

    expect(config.server?.proxy?.["/api"]).toMatchObject({
      changeOrigin: false,
      target: "http://127.0.0.1:3001",
      ws: true,
    });
  });
});
