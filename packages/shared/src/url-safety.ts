const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}

export interface UrlSafetyOptions {
  allowPrivateTargets?: boolean;
  allowedHosts?: string[];
}

export function assertSafeTargetUrl(rawUrl: string, opts: UrlSafetyOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (opts.allowedHosts?.includes(host)) {
    return;
  }
  if (opts.allowPrivateTargets) {
    return;
  }
  if (PRIVATE_HOSTS.has(host) || isPrivateIpv4(host) || host.endsWith(".local")) {
    throw new Error("Target URL resolves to a private/localhost network, which is blocked");
  }
}
