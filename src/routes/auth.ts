import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { registerUser, loginUser, refreshAccessToken, logoutUser } from '../services/authService';
import { authenticate, requireRole } from '../middleware/authMiddleware';

const RegisterSchema = z.object({
  name:     z.string().min(1),
  email:    z.string().email(),
  password: z.string().min(8),
  role:     z.nativeEnum(Role),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/auth/register — ADMIN only
  fastify.post(
    '/api/auth/register',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const user = await registerUser(parsed.data.name, parsed.data.email, parsed.data.password, parsed.data.role);
        return reply.code(201).send({ success: true, user });
      } catch (err: any) {
        if (err.code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'Email already registered' });
        }
        throw err;
      }
    }
  );

  // POST /api/auth/login
  fastify.post(
    '/api/auth/login',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = LoginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const result = await loginUser(parsed.data.email, parsed.data.password);
      if ('error' in result) {
        if (result.error === 'ACCOUNT_DISABLED') {
          return reply.code(403).send({ success: false, error: 'Account is disabled' });
        }
        return reply.code(401).send({ success: false, error: 'Invalid credentials' });
      }
      return reply.code(200).send({ success: true, token: result.token, refresh_token: result.refresh_token, user: result.user });
    }
  );

  // POST /api/auth/refresh
  fastify.post(
    '/api/auth/refresh',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RefreshSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'refresh_token is required' });
      }
      const result = await refreshAccessToken(parsed.data.refresh_token);
      if ('error' in result) {
        return reply.code(401).send({ success: false, error: 'Invalid or expired refresh token' });
      }
      return reply.code(200).send({ success: true, token: result.token, user: result.user });
    }
  );

  // POST /api/auth/logout
  fastify.post(
    '/api/auth/logout',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RefreshSchema.safeParse(request.body);
      if (parsed.success) {
        await logoutUser(parsed.data.refresh_token);
      }
      return reply.code(200).send({ success: true, message: 'Logged out' });
    }
  );

  // GET /api/auth/me
  fastify.get(
    '/api/auth/me',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({ success: true, user: request.user });
    }
  );
}
