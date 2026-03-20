export type UserRole = 'admin' | 'viewer';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  createdAt?: Date;
}

export interface AuthConfig {
  strategy: 'db' | 'env';
  sessionSecret: string;
  sessionTtlMinutes: number;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface AuthStore {
  loadUsers(): Promise<UserRecord[]>;
  findByEmail(email: string): Promise<UserRecord | null>;
}
