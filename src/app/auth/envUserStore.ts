import type { AuthStore, UserRecord } from './types';

interface EnvUser {
  email: string;
  password_hash: string;
  role: 'admin' | 'viewer';
  is_active?: boolean;
}

function normalizeUser(raw: EnvUser, index: number): UserRecord | null {
  if (!raw.email || !raw.password_hash || !raw.role) {
    return null;
  }
  return {
    id: `env-${index}`,
    email: raw.email.toLowerCase(),
    passwordHash: raw.password_hash,
    role: raw.role === 'admin' ? 'admin' : 'viewer',
    isActive: raw.is_active !== false,
    createdAt: undefined
  };
}

export class EnvUserStore implements AuthStore {
  private readonly users: UserRecord[];

  constructor(env: Record<string, string | undefined>) {
    const rawJson = env.AUTH_USERS_JSON || '[]';
    let parsed: EnvUser[] = [];
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = [];
    }
    this.users = parsed
      .map((u, idx) => normalizeUser(u, idx))
      .filter((u): u is UserRecord => Boolean(u));
  }

  async loadUsers(): Promise<UserRecord[]> {
    return this.users;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.toLowerCase();
    const user = this.users.find((u) => u.email === normalized && u.isActive);
    return user || null;
  }
}
