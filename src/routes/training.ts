import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TrainingStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateTrainingSchema = z.object({
  userId:          z.string().min(1),
  bezeichnung:     z.string().min(1),
  anbieter:        z.string().optional(),
  abgeschlossenAm: z.string().datetime().optional(),
  gueltigBis:      z.string().datetime().optional(),
  pflichtschulung: z.boolean().default(false),
  zertifikatUrl:   z.string().optional(),
  bemerkungen:     z.string().optional(),
});

const UpdateTrainingSchema = z.object({
  bezeichnung:     z.string().min(1).optional(),
  anbieter:        z.string().nullable().optional(),
  abgeschlossenAm: z.string().datetime().nullable().optional(),
  gueltigBis:      z.string().datetime().nullable().optional(),
  status:          z.nativeEnum(TrainingStatus).optional(),
  pflichtschulung: z.boolean().optional(),
  zertifikatUrl:   z.string().nullable().optional(),
  bemerkungen:     z.string().nullable().optional(),
});

const trainingInclude = {
  user: { select: { id: true, name: true } },
};

export async function trainingRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/training/overdue — static, registered before /:id
  fastify.get(
    '/training/overdue',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now = new Date();
      await prisma.trainingRecord.updateMany({
        where: {
          gueltigBis: { lt: now },
          status:     { not: TrainingStatus.ABGELAUFEN },
        },
        data: { status: TrainingStatus.ABGELAUFEN },
      });
      const records = await prisma.trainingRecord.findMany({
        where:   { status: TrainingStatus.ABGELAUFEN },
        include: trainingInclude,
        orderBy: { gueltigBis: 'asc' },
      });
      return reply.code(200).send({ success: true, records });
    }
  );

  // GET /api/training/user/:userId — static 'user' prefix, before /:id
  fastify.get<{ Params: { userId: string } }>(
    '/training/user/:userId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const records = await prisma.trainingRecord.findMany({
        where:   { userId: request.params.userId },
        include: trainingInclude,
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, records });
    }
  );

  // GET /api/training
  fastify.get(
    '/training',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId, status, pflichtschulung } = request.query as {
        userId?: string; status?: string; pflichtschulung?: string;
      };
      const where: Record<string, unknown> = {};
      if (userId)         where.userId = userId;
      if (status)         where.status = status;
      if (pflichtschulung !== undefined) where.pflichtschulung = pflichtschulung === 'true';
      const records = await prisma.trainingRecord.findMany({
        where,
        include: trainingInclude,
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, records });
    }
  );

  // POST /api/training
  fastify.post(
    '/training',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateTrainingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { abgeschlossenAm, gueltigBis, ...rest } = parsed.data;
      const record = await prisma.trainingRecord.create({
        data: {
          ...rest,
          abgeschlossenAm: abgeschlossenAm ? new Date(abgeschlossenAm) : undefined,
          gueltigBis:      gueltigBis      ? new Date(gueltigBis)      : undefined,
        },
        include: trainingInclude,
      });
      return reply.code(201).send({ success: true, record });
    }
  );

  // PUT /api/training/:id/complete — registered before /:id
  fastify.put<{ Params: { id: string } }>(
    '/training/:id/complete',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const record = await prisma.trainingRecord.update({
          where:   { id: request.params.id },
          data:    { status: TrainingStatus.ABGESCHLOSSEN, abgeschlossenAm: new Date() },
          include: trainingInclude,
        });
        return reply.code(200).send({ success: true, record });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Training record not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/training/:id
  fastify.put<{ Params: { id: string } }>(
    '/training/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateTrainingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { abgeschlossenAm, gueltigBis, ...rest } = parsed.data;
        const record = await prisma.trainingRecord.update({
          where: { id: request.params.id },
          data: {
            ...rest,
            ...(abgeschlossenAm !== undefined && {
              abgeschlossenAm: abgeschlossenAm ? new Date(abgeschlossenAm) : null,
            }),
            ...(gueltigBis !== undefined && {
              gueltigBis: gueltigBis ? new Date(gueltigBis) : null,
            }),
          },
          include: trainingInclude,
        });
        return reply.code(200).send({ success: true, record });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Training record not found' });
        }
        throw err;
      }
    }
  );
}
