export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface AuthUser {
  id: number;
  email: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
