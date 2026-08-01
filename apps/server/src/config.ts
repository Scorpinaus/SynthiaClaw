export interface ServerConfig {
  host: string;
  port: number;
  frontendOrigin: string;
}

export function readServerConfig(
  environment: Record<string, string | undefined> = process.env,
): ServerConfig {
  const rawPort = environment.PORT ?? "3001";
  const port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const frontendOrigin = normalizeFrontendOrigin(
    environment.FRONTEND_ORIGIN ?? "http://127.0.0.1:5173",
  );

  return {
    host: environment.HOST ?? "127.0.0.1",
    port,
    frontendOrigin,
  };
}

export function normalizeFrontendOrigin(rawFrontendOrigin: string): string {
  let frontendUrl: URL;
  try {
    frontendUrl = new URL(rawFrontendOrigin);
  } catch {
    throw invalidFrontendOriginError();
  }
  if (
    !["http:", "https:"].includes(frontendUrl.protocol) ||
    frontendUrl.username !== "" ||
    frontendUrl.password !== "" ||
    frontendUrl.pathname !== "/" ||
    frontendUrl.search !== "" ||
    frontendUrl.hash !== ""
  ) {
    throw invalidFrontendOriginError();
  }

  return frontendUrl.origin;
}

function invalidFrontendOriginError(): Error {
  return new Error(
    "FRONTEND_ORIGIN must be an HTTP(S) origin without a path.",
  );
}
