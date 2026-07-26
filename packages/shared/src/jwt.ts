import jwt from "jsonwebtoken";

export interface AuthTokenPayload {
  userId: string;
  email: string;
  /**
   * The owner's token version at the time of signing. A logout bumps the stored
   * version, which retires every token issued before it: clearing the cookie alone
   * only asks the browser to forget a token that stays valid for a week.
   */
  tokenVersion: number;
}

export function signAuthToken(payload: AuthTokenPayload, secret: string, expiresIn = "7d"): string {
  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyAuthToken(token: string, secret: string): AuthTokenPayload {
  return jwt.verify(token, secret) as unknown as AuthTokenPayload;
}

/**
 * Short-lived token that authorises the noVNC stream of exactly one browser
 * session. It is scoped to both the session and its owner, so it cannot be
 * replayed against another session even by an authenticated user.
 */
export interface SessionTokenPayload {
  sessionId: string;
  userId: string;
  scope: "vnc";
}

export function signSessionToken(payload: SessionTokenPayload, secret: string, ttlSeconds: number): string {
  return jwt.sign(payload, secret, { expiresIn: ttlSeconds });
}

export function verifySessionToken(token: string, secret: string): SessionTokenPayload {
  return jwt.verify(token, secret) as unknown as SessionTokenPayload;
}
