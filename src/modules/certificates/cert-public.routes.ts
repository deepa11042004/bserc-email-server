import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../common/asyncHandler.js';
import { verifyCertificate } from './cert-verify.service.js';

export const certPublicRouter = Router();

// Aggressive rate limiting on the unauthenticated public endpoint.
// 60 lookups / minute / IP is generous for legitimate viewers (typically 1-2 lookups
// per certificate) and slows brute-force enumeration enough to make it useless against
// 24-char base64url codes (~143-bit search space).
const verifyLimiter = rateLimit({
  windowMs: 60_000,
  max: env.NODE_ENV === 'test' ? 1000 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification requests. Please try again shortly.' },
});

const extractIp = (req: { ip?: string; ips?: string[] }): string | null => {
  if (req.ips && req.ips.length > 0) return req.ips[0]!;
  return req.ip ?? null;
};

certPublicRouter.get(
  '/verify/:code',
  verifyLimiter,
  asyncHandler(async (req, res) => {
    const result = await verifyCertificate(req.params.code ?? '', extractIp(req));
    // Always return 200 — clients differentiate via `valid` boolean. This avoids leaking
    // existence information through status codes for codes that are "pending" or "draft".
    res.json(result);
  })
);
