import express from 'express';
import cookieParser from 'cookie-parser';
import type { Application as AppContext } from '../createApplication';
import type { Request, Response } from 'express';
import { createAuthMiddleware } from './authMiddleware';

export function createHttpServer(appContext: AppContext) {
  const app = express();
  const auth = appContext.auth;
  const authMw = createAuthMiddleware(auth);

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(authMw.attachSession);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/auth/login', async (req: Request, res: Response) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'missing_credentials' });
    }
    const session = await auth.authenticate({ email, password });
    if (!session) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    res.cookie('session_token', session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: appContext.config.auth.sessionTtlMinutes * 60 * 1000
    });
    return res.json({ ok: true, role: session.role });
  });

  app.post('/auth/logout', (req: Request, res: Response) => {
    const token = req.cookies?.session_token;
    if (token) {
      auth.invalidate(token);
      res.clearCookie('session_token');
    }
    res.json({ ok: true });
  });

  app.get('/admin/api/me', authMw.requireRole('viewer'), (req: Request, res: Response) => {
    res.json({ role: req.userRole || null });
  });

  // Placeholder protected route to validate middleware
  app.get('/admin/api/protected', authMw.requireRole('admin'), (_req, res) => {
    res.json({ ok: true });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  return app;
}
