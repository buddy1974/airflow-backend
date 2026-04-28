import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Beatmungsmodus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateCarePlanSchema = z.object({
  patientId:           z.string().min(1),
  titel:               z.string().min(1),
  beschreibung:        z.string().optional(),
  beatmungsmodus:      z.nativeEnum(Beatmungsmodus).optional(),
  atemzugvolumen:      z.number().int().positive().optional(),
  peep:                z.number().positive().optional(),
  fio2:                z.number().min(0.21).max(1.0).optional(),
  atemfrequenzGeraet:  z.number().int().positive().optional(),
  pflegeziele:         z.string().optional(),
  massnahmen:          z.string().optional(),
  besonderheiten:      z.string().optional(),
  gueltigAb:           z.string().datetime().optional(),
  gueltigBis:          z.string().datetime().optional(),
  isActive:            z.boolean().default(true),
});

const UpdateCarePlanSchema = z.object({
  titel:               z.string().min(1).optional(),
  beschreibung:        z.string().nullable().optional(),
  beatmungsmodus:      z.nativeEnum(Beatmungsmodus).nullable().optional(),
  atemzugvolumen:      z.number().int().positive().nullable().optional(),
  peep:                z.number().positive().nullable().optional(),
  fio2:                z.number().min(0.21).max(1.0).nullable().optional(),
  atemfrequenzGeraet:  z.number().int().positive().nullable().optional(),
  pflegeziele:         z.string().nullable().optional(),
  massnahmen:          z.string().nullable().optional(),
  besonderheiten:      z.string().nullable().optional(),
  gueltigAb:           z.string().datetime().optional(),
  gueltigBis:          z.string().datetime().nullable().optional(),
  isActive:            z.boolean().optional(),
});

export async function carePlanRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/care-plans/patient/:patientId/active — most specific, registered first
  fastify.get<{ Params: { patientId: string } }>(
    '/care-plans/patient/:patientId/active',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const carePlan = await prisma.carePlan.findFirst({
        where:   { patientId: request.params.patientId, isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, carePlan });
    }
  );

  // GET /api/care-plans/patient/:patientId
  fastify.get<{ Params: { patientId: string } }>(
    '/care-plans/patient/:patientId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const carePlans = await prisma.carePlan.findMany({
        where:   { patientId: request.params.patientId },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, carePlans });
    }
  );

  // GET /api/care-plans/:id
  fastify.get<{ Params: { id: string } }>(
    '/care-plans/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const carePlan = await prisma.carePlan.findUnique({ where: { id: request.params.id } });
      if (!carePlan) return reply.code(404).send({ success: false, error: 'Care plan not found' });
      return reply.code(200).send({ success: true, carePlan });
    }
  );

  // POST /api/care-plans
  fastify.post(
    '/care-plans',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateCarePlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { gueltigAb, gueltigBis, ...rest } = parsed.data;
      const carePlan = await prisma.carePlan.create({
        data: {
          ...rest,
          createdById: request.user!.id,
          gueltigAb:   gueltigAb ? new Date(gueltigAb) : undefined,
          gueltigBis:  gueltigBis ? new Date(gueltigBis) : undefined,
        },
      });
      return reply.code(201).send({ success: true, carePlan });
    }
  );

  // PUT /api/care-plans/:id
  fastify.put<{ Params: { id: string } }>(
    '/care-plans/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateCarePlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { gueltigAb, gueltigBis, ...rest } = parsed.data;
        const carePlan = await prisma.carePlan.update({
          where: { id: request.params.id },
          data: {
            ...rest,
            ...(gueltigAb && { gueltigAb: new Date(gueltigAb) }),
            ...(gueltigBis !== undefined && {
              gueltigBis: gueltigBis ? new Date(gueltigBis) : null,
            }),
          },
        });
        return reply.code(200).send({ success: true, carePlan });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Care plan not found' });
        }
        throw err;
      }
    }
  );

  // DELETE /api/care-plans/:id — deactivate (set isActive = false)
  fastify.delete<{ Params: { id: string } }>(
    '/care-plans/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await prisma.carePlan.update({
          where: { id: request.params.id },
          data:  { isActive: false },
        });
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Care plan not found' });
        }
        throw err;
      }
    }
  );
}
