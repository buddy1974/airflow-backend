import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RecruitmentStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateRecruitmentSchema = z.object({
  vorname:        z.string().min(1),
  nachname:       z.string().min(1),
  email:          z.string().email(),
  telefon:        z.string().optional(),
  position:       z.string().min(1),
  bewerbungstext: z.string().optional(),
  cvUrl:          z.string().optional(),
});

const UpdateRecruitmentSchema = z.object({
  status:  z.nativeEnum(RecruitmentStatus).optional(),
  notizen: z.string().nullable().optional(),
});

export async function recruitmentRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/recruitment
  fastify.get(
    '/recruitment',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status } = request.query as { status?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      const applications = await prisma.recruitmentApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, applications });
    }
  );

  // GET /api/recruitment/:id
  fastify.get<{ Params: { id: string } }>(
    '/recruitment/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const application = await prisma.recruitmentApplication.findUnique({
        where: { id: request.params.id },
      });
      if (!application) return reply.code(404).send({ success: false, error: 'Application not found' });
      return reply.code(200).send({ success: true, application });
    }
  );

  // POST /api/recruitment — public route, no authentication
  fastify.post(
    '/recruitment',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateRecruitmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const application = await prisma.recruitmentApplication.create({ data: parsed.data });
      return reply.code(201).send({ success: true, application });
    }
  );

  // PUT /api/recruitment/:id/hire — registered before /:id
  fastify.put<{ Params: { id: string } }>(
    '/recruitment/:id/hire',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const application = await prisma.recruitmentApplication.update({
          where: { id: request.params.id },
          data:  { status: RecruitmentStatus.EINGESTELLT, eingestelltAm: new Date() },
        });
        return reply.code(200).send({ success: true, application });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Application not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/recruitment/:id
  fastify.put<{ Params: { id: string } }>(
    '/recruitment/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateRecruitmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const application = await prisma.recruitmentApplication.update({
          where: { id: request.params.id },
          data:  parsed.data,
        });
        return reply.code(200).send({ success: true, application });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Application not found' });
        }
        throw err;
      }
    }
  );
}
