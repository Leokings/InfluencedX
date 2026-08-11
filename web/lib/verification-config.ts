export function applicationOriginForRequest(request: Request): string {
  const requestUrl = new URL(request.url);
  const allowedOrigins = configuredApplicationOrigins();

  if (
    !process.env.VERCEL &&
    process.env.NODE_ENV !== "production" &&
    isAllowedDevelopmentHost(requestUrl.hostname) &&
    requestUrl.port
  ) {
    if (!/^https?:$/.test(requestUrl.protocol)) {
      throw new Error("Unsupported local application protocol.");
    }
    return requestUrl.origin;
  }

  if (!allowedOrigins.has(requestUrl.origin)) {
    throw new Error("Unrecognized InfluencedX application origin.");
  }
  return requestUrl.origin;
}

export function applicationOriginForMetadata(): string {
  const explicitOrigin = process.env.XPROOF_APP_ORIGIN?.trim();
  if (explicitOrigin) return normalizeConfiguredOrigin(explicitOrigin);

  for (const variable of [
    "VERCEL_PROJECT_PRODUCTION_URL",
    "VERCEL_BRANCH_URL",
    "VERCEL_URL",
  ] as const) {
    const hostname = process.env[variable]?.trim();
    if (hostname) return originFromVercelHostname(hostname);
  }

  return "http://localhost:3000";
}

export function verificationMutationsEnabled(): boolean {
  if (!process.env.VERCEL) return true;
  return process.env.XPROOF_VERIFICATION_MUTATIONS_ENABLED === "true";
}

export function marketplaceMutationsEnabled(): boolean {
  if (!process.env.VERCEL) return true;
  const explicit = process.env.XPROOF_MARKETPLACE_MUTATIONS_ENABLED;
  if (explicit !== undefined) return explicit === "true";
  return verificationMutationsEnabled();
}

function configuredApplicationOrigins(): Set<string> {
  const origins = new Set<string>();
  const explicitOrigin = process.env.XPROOF_APP_ORIGIN?.trim();
  if (explicitOrigin) origins.add(normalizeConfiguredOrigin(explicitOrigin));

  if (process.env.VERCEL_ENV !== "production") {
    for (const variable of ["VERCEL_URL", "VERCEL_BRANCH_URL"] as const) {
      const hostname = process.env[variable]?.trim();
      if (hostname) origins.add(originFromVercelHostname(hostname));
    }
  }
  return origins;
}

function normalizeConfiguredOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("XPROOF_APP_ORIGIN is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("XPROOF_APP_ORIGIN must be an HTTPS origin without a path.");
  }
  return url.origin;
}

function originFromVercelHostname(value: string): string {
  if (
    value.includes("://") ||
    value.includes("/") ||
    value.includes("@") ||
    /\s/.test(value)
  ) {
    throw new Error("A Vercel deployment hostname is invalid.");
  }
  const url = new URL(`https://${value}`);
  if (!url.hostname || url.port) {
    throw new Error("A Vercel deployment hostname is invalid.");
  }
  return url.origin;
}

function isAllowedDevelopmentHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}
