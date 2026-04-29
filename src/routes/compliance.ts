import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ComplianceStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateComplianceSchema = z.object({
  bezeichnung:  z.string().min(1),
  beschreibung: z.string().optional(),
  faelligAm:    z.string().datetime().optional(),
  mdkRelevant:  z.boolean().default(true),
  kategorie:    z.string().optional(),
  bemerkungen:  z.string().optional(),
});

const UpdateComplianceSchema = z.object({
  bezeichnung:  z.string().min(1).optional(),
  beschreibung: z.string().nullable().optional(),
  status:       z.nativeEnum(ComplianceStatus).optional(),
  faelligAm:    z.string().datetime().nullable().optional(),
  mdkRelevant:  z.boolean().optional(),
  kategorie:    z.string().nullable().optional(),
  bemerkungen:  z.string().nullable().optional(),
});

export async function complianceRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/compliance/mdk — static, registered before /:id
  fastify.get(
    '/compliance/mdk',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const checks = await prisma.complianceCheck.findMany({
        where:   { mdkRelevant: true },
        orderBy: { faelligAm: 'asc' },
      });
      return reply.code(200).send({ success: true, checks });
    }
  );

  // GET /api/compliance/overdue — static, registered before /:id
  fastify.get(
    '/compliance/overdue',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now = new Date();
      const checks = await prisma.complianceCheck.findMany({
        where: {
          faelligAm: { lt: now },
          status:    { not: ComplianceStatus.KONFORM },
        },
        orderBy: { faelligAm: 'asc' },
      });
      return reply.code(200).send({ success: true, checks });
    }
  );

  // GET /api/compliance
  fastify.get(
    '/compliance',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status } = request.query as { status?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      const checks = await prisma.complianceCheck.findMany({
        where,
        orderBy: { faelligAm: 'asc' },
      });
      return reply.code(200).send({ success: true, checks });
    }
  );

  // POST /api/compliance
  fastify.post(
    '/compliance',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateComplianceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { faelligAm, ...rest } = parsed.data;
      const check = await prisma.complianceCheck.create({
        data: { ...rest, faelligAm: faelligAm ? new Date(faelligAm) : undefined },
      });
      return reply.code(201).send({ success: true, check });
    }
  );

  // PUT /api/compliance/:id/complete — registered before /:id
  fastify.put<{ Params: { id: string } }>(
    '/compliance/:id/complete',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const check = await prisma.complianceCheck.update({
          where: { id: request.params.id },
          data:  { status: ComplianceStatus.KONFORM, erledigtAm: new Date(), erledigtVonId: request.user!.id },
        });
        return reply.code(200).send({ success: true, check });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Compliance check not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/compliance/:id
  fastify.put<{ Params: { id: string } }>(
    '/compliance/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateComplianceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { faelligAm, ...rest } = parsed.data;
        const check = await prisma.complianceCheck.update({
          where: { id: request.params.id },
          data:  {
            ...rest,
            ...(faelligAm !== undefined && {
              faelligAm: faelligAm ? new Date(faelligAm) : null,
            }),
          },
        });
        return reply.code(200).send({ success: true, check });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Compliance check not found' });
        }
        throw err;
      }
    }
  );
}
