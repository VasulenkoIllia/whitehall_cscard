import crypto from 'crypto';
import type { UserRecord } from './types';

export interface SessionData {
  token: string;
  userId: string;
  role: UserRecord['role'];
  createdAt: number;
  expiresAt: number;
}

export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionData>();

  constructor(private readonly ttlMs: number) {}

  createSession(user: UserRecord): SessionData {
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const session: SessionData = {
      token,
      userId: user.id,
      role: user.role,
      createdAt: now,
      expiresAt: now + this.ttlMs
    };
    this.sessions.set(token, session);
    return session;
  }

  getSession(token: string | undefined | null): SessionData | null {
    if (!token) {
      return null;
    }
    const session = this.sessions.get(token);
    if (!session) {
      return null;
    }
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  invalidate(token: string): void {
    this.sessions.delete(token);
  }
}
