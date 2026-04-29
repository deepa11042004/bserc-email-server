import type { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { badRequest } from './errors.js';

export const validateBody =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(badRequest('Validation failed', result.error.flatten()));
    req.body = result.data;
    next();
  };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isValidEmail = (s: string) => EMAIL_RE.test(s);
