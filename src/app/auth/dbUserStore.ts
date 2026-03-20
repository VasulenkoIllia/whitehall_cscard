import type { AuthStore, UserRecord } from './types';

export interface UserDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export class DbUserStore implements AuthStore {
  constructor(private readonly client: UserDbClient) {}

  async loadUsers(): Promise<UserRecord[]> {
    const result = await this.client.query<UserRecord>(
      'SELECT id, email, password_hash as "passwordHash", role, is_active as "isActive", created_at as "createdAt" FROM users'
    );
    return result.rows;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.client.query<UserRecord>(
      'SELECT id, email, password_hash as "passwordHash", role, is_active as "isActive", created_at as "createdAt" FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    );
    return result.rows[0] || null;
  }
}
