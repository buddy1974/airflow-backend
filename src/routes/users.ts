import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import { registerUser } from '../services/authService';
import prisma from '../db/prisma';

const UpdateUserSchema = z.object({
  name:     z.string().min(1).optional(),
  role:     z.nativeEnum(Role).optional(),
  isActive: z.boolean().optional(),
});

export async function userRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/users — ADMIN only
  fastify.get(
    '/api/users',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const users = await prisma.user.findMany({
        select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, users });
    }
  );

  // GET /api/users/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.params.id },
        select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
      });
      if (!user) return reply.code(404).send({ success: false, error: 'User not found' });
      return reply.code(200).send({ success: true, user });
    }
  );

  // PUT /api/users/:id — ADMIN only
  fastify.put<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const user = await prisma.user.update({
        where: { id: request.params.id },
        data:  parsed.data,
        select: { id: true, name: true, email: true, role: true, isActive: true },
      });
      return reply.code(200).send({ success: true, user });
    }
  );

  // DELETE /api/users/:id/deactivate — ADMIN only (soft delete)
  fastify.delete<{ Params: { id: string } }>(
    '/api/users/:id/deactivate',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (request.user?.id === request.params.id) {
        return reply.code(400).send({ success: false, error: 'Cannot deactivate your own account' });
      }
      const user = await prisma.user.update({
        where: { id: request.params.id },
        data:  { isActive: false },
        select: { id: true, name: true, email: true, isActive: true },
      });
      // Invalidate all refresh tokens for this user
      await prisma.refreshToken.deleteMany({ where: { userId: request.params.id } });
      return reply.code(200).send({ success: true, user });
    }
  );
}
