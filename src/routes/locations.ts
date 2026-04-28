import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateLocationSchema = z.object({
  name:    z.string().min(1),
  address: z.string().optional(),
  phone:   z.string().optional(),
});

const UpdateLocationSchema = z.object({
  name:     z.string().min(1).optional(),
  address:  z.string().optional(),
  phone:    z.string().optional(),
  isActive: z.boolean().optional(),
});

export async function locationRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/locations
  fastify.get(
    '/api/locations',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const locations = await prisma.location.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      });
      return reply.code(200).send({ success: true, locations });
    }
  );

  // POST /api/locations — ADMIN only
  fastify.post(
    '/api/locations',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateLocationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const location = await prisma.location.create({ data: parsed.data });
      return reply.code(201).send({ success: true, location });
    }
  );

  // PUT /api/locations/:id — ADMIN only
  fastify.put<{ Params: { id: string } }>(
    '/api/locations/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateLocationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const location = await prisma.location.update({
        where: { id: request.params.id },
        data:  parsed.data,
      });
      return reply.code(200).send({ success: true, location });
    }
  );
}
