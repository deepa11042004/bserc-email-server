import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from './auth.service.js';
import { forbidden, unauthorized } from '../../common/errors.js';
import type { Role } from './auth.types.js';

export const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header('authorization') || req.header('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return next(unauthorized('Missing bearer token'));
  try {
    req.user = verifyToken(m[1]!);
    next();
  } catch (e) {
    next(e);
  }
};

export const requireRole = (...roles: Role[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join('|')}`));
    next();
  };
};
