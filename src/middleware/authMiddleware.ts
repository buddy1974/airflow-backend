import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

interface JwtPayload {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ success: false, error: 'Missing or invalid authorization header' });
  }

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    request.user = payload;
  } catch {
    return reply.code(401).send({ success: false, error: 'Invalid or expired token' });
  }
}

export function requireRole(roles: Role[]) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.code(401).send({ success: false, error: 'Unauthenticated' });
    }
    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ success: false, error: 'Insufficient permissions' });
    }
  };
}
