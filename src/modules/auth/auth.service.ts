import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { appPool } from '../../db/pools.js';
import { env } from '../../config/env.js';
import { unauthorized } from '../../common/errors.js';
import type { AuthUser, Role } from './auth.types.js';

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  name: string | null;
  role: Role;
  is_active: 0 | 1;
}

export const login = async (email: string, password: string) => {
  const [rows] = await appPool().query<UserRow[] & any[]>(
    'SELECT id, email, password_hash, name, role, is_active FROM users WHERE email = ? LIMIT 1',
    [email]
  );
  const user = rows[0] as UserRow | undefined;
  if (!user || !user.is_active) throw unauthorized('Invalid credentials');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw unauthorized('Invalid credentials');
  const payload: AuthUser = { id: user.id, email: user.email, role: user.role };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });
  return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
};

export const verifyToken = (token: string): AuthUser => {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthUser & jwt.JwtPayload;
    return { id: decoded.id, email: decoded.email, role: decoded.role };
  } catch {
    throw unauthorized('Invalid or expired token');
  }
};
