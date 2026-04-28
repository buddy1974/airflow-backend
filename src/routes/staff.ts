import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateStaffSchema = z.object({
  userId:    z.string().min(1),
  jobTitle:  z.string().min(1),
  phone:     z.string().optional(),
  address:   z.string().optional(),
  startDate: z.string().datetime().optional(),
  locationId: z.string().optional(),
});

const UpdateStaffSchema = z.object({
  jobTitle:   z.string().min(1).optional(),
  phone:      z.string().optional(),
  address:    z.string().optional(),
  startDate:  z.string().datetime().optional(),
  locationId: z.string().nullable().optional(),
});

const staffInclude = {
  user: { select: { id: true, name: true, email: true, role: true } },
  location: { select: { id: true, name: true } },
};

export async function staffRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/staff
  fastify.get(
    '/api/staff',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const staff = await prisma.staff.findMany({
        include: staffInclude,
        orderBy: { createdAt: 'asc' },
      });
      return reply.code(200).send({ success: true, staff });
    }
  );

  // GET /api/staff/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/staff/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const staff = await prisma.staff.findUnique({
        where: { id: request.params.id },
        include: staffInclude,
      });
      if (!staff) return reply.code(404).send({ success: false, error: 'Staff record not found' });
      return reply.code(200).send({ success: true, staff });
    }
  );

  // POST /api/staff — ADMIN only
  fastify.post(
    '/api/staff',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateStaffSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const staff = await prisma.staff.create({
          data: {
            userId:    parsed.data.userId,
            jobTitle:  parsed.data.jobTitle,
            phone:     parsed.data.phone,
            address:   parsed.data.address,
            startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
            locationId: parsed.data.locationId,
          },
          include: staffInclude,
        });
        return reply.code(201).send({ success: true, staff });
      } catch (err: any) {
        if (err.code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'Staff record already exists for this user' });
        }
        if (err.code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'User not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/staff/:id — ADMIN only
  fastify.put<{ Params: { id: string } }>(
    '/api/staff/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateStaffSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const staff = await prisma.staff.update({
        where: { id: request.params.id },
        data: {
          ...parsed.data,
          startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : undefined,
        },
        include: staffInclude,
      });
      return reply.code(200).send({ success: true, staff });
    }
  );
}
