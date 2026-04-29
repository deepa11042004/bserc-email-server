import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { validateBody } from '../../common/validate.js';
import { login } from './auth.service.js';

export const authRouter = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  '/login',
  validateBody(LoginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof LoginSchema>;
    const result = await login(email, password);
    res.json(result);
  })
);

authRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    res.json({ user: req.user || null });
  })
);
