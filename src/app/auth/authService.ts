import type { AuthStore, Credentials, AuthConfig, UserRecord } from './types';
import { verifyPassword } from './password';
import { InMemorySessionStore, type SessionData } from './sessionStore';

export class AuthService {
  private readonly store: AuthStore;

  private readonly sessionStore: InMemorySessionStore;

  constructor(store: AuthStore, config: AuthConfig) {
    this.store = store;
    const ttlMs = Math.max(5, config.sessionTtlMinutes || 60) * 60 * 1000;
    this.sessionStore = new InMemorySessionStore(ttlMs);
  }

  async authenticate(credentials: Credentials): Promise<SessionData | null> {
    const user = await this.store.findByEmail(credentials.email);
    if (!user || !user.isActive) {
      return null;
    }
    const ok = await verifyPassword(user.passwordHash, credentials.password);
    if (!ok) {
      return null;
    }
    return this.sessionStore.createSession(user);
  }

  getSession(token: string | undefined | null): SessionData | null {
    return this.sessionStore.getSession(token);
  }

  invalidate(token: string): void {
    if (token) {
      this.sessionStore.invalidate(token);
    }
  }

  async loadUsers(): Promise<UserRecord[]> {
    return this.store.loadUsers();
  }
}
