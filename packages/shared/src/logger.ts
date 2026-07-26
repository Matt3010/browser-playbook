import pino from "pino";

const REDACT_PATHS = [
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "encryptedValue",
  "*.encryptedValue",
  "credentials",
  "*.credentials",
  "token",
  "*.token",
  "authorization",
  "*.authorization"
];

export type Logger = pino.Logger;

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" }
  });
}

/**
 * Removes any occurrence of known secret values from a free-form string so that
 * credentials never reach logs, API responses or execution error messages.
 */
export function maskSecrets(input: string, secrets: string[]): string {
  let output = input;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    output = output.split(secret).join("***");
  }
  return output;
}
