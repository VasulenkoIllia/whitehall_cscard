import type { Request, Response, NextFunction } from 'express';
import type { AuthService } from '../auth/authService';
import type { UserRole } from '../auth/types';

declare module 'express-serve-static-core' {
  interface Request {
    userRole?: UserRole;
    sessionToken?: string;
  }
}

export function createAuthMiddleware(auth: AuthService) {
  return {
    attachSession(req: Request, _res: Response, next: NextFunction) {
      const token = req.cookies?.session_token || null;
      const session = auth.getSession(token);
      if (session) {
        req.userRole = session.role;
        req.sessionToken = session.token;
      }
      next();
    },
    requireRole(minRole: UserRole) {
      return (req: Request, res: Response, next: NextFunction) => {
        const role = req.userRole;
        if (!role) {
          return res.status(401).json({ error: 'unauthorized' });
        }
        if (minRole === 'viewer') {
          return next();
        }
        if (role === 'admin') {
          return next();
        }
        return res.status(403).json({ error: 'forbidden' });
      };
    }
  };
}
