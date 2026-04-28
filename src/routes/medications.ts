import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MedicationRoute } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateMedicationSchema = z.object({
  patientId:        z.string().min(1),
  prescribedById:   z.string().optional(),
  wirkstoff:        z.string().min(1),
  handelsname:      z.string().optional(),
  staerke:          z.string().min(1),
  darreichungsform: z.string().optional(),
  route:            z.nativeEnum(MedicationRoute).default('ORAL'),
  dosierung:        z.string().min(1),
  haeufigkeit:      z.string().min(1),
  isBtm:            z.boolean().default(false),
  btmNummer:        z.string().optional(),
  isInhalativum:    z.boolean().default(false),
  anweisung:        z.string().optional(),
  startDatum:       z.string().datetime().optional(),
  endDatum:         z.string().datetime().optional(),
  isActive:         z.boolean().default(true),
});

const UpdateMedicationSchema = z.object({
  prescribedById:   z.string().nullable().optional(),
  wirkstoff:        z.string().min(1).optional(),
  handelsname:      z.string().nullable().optional(),
  staerke:          z.string().min(1).optional(),
  darreichungsform: z.string().nullable().optional(),
  route:            z.nativeEnum(MedicationRoute).optional(),
  dosierung:        z.string().min(1).optional(),
  haeufigkeit:      z.string().min(1).optional(),
  isBtm:            z.boolean().optional(),
  btmNummer:        z.string().nullable().optional(),
  isInhalativum:    z.boolean().optional(),
  anweisung:        z.string().nullable().optional(),
  startDatum:       z.string().datetime().optional(),
  endDatum:         z.string().datetime().nullable().optional(),
  isActive:         z.boolean().optional(),
});

export async function medicationRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/medications/btm — ADMIN only, static route registered first
  fastify.get(
    '/medications/btm',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const medications = await prisma.medication.findMany({
        where:   { isBtm: true },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, medications });
    }
  );

  // GET /api/medications/patient/:patientId/active — registered before /patient/:patientId
  fastify.get<{ Params: { patientId: string } }>(
    '/medications/patient/:patientId/active',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const medications = await prisma.medication.findMany({
        where:   { patientId: request.params.patientId, isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, medications });
    }
  );

  // GET /api/medications/patient/:patientId
  fastify.get<{ Params: { patientId: string } }>(
    '/medications/patient/:patientId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const medications = await prisma.medication.findMany({
        where:   { patientId: request.params.patientId },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, medications });
    }
  );

  // GET /api/medications/:id
  fastify.get<{ Params: { id: string } }>(
    '/medications/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const medication = await prisma.medication.findUnique({ where: { id: request.params.id } });
      if (!medication) return reply.code(404).send({ success: false, error: 'Medication not found' });
      return reply.code(200).send({ success: true, medication });
    }
  );

  // POST /api/medications
  fastify.post(
    '/medications',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateMedicationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { startDatum, endDatum, ...rest } = parsed.data;
      const medication = await prisma.medication.create({
        data: {
          ...rest,
          startDatum: startDatum ? new Date(startDatum) : undefined,
          endDatum:   endDatum ? new Date(endDatum) : undefined,
        },
      });
      return reply.code(201).send({ success: true, medication });
    }
  );

  // PUT /api/medications/:id
  fastify.put<{ Params: { id: string } }>(
    '/medications/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateMedicationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { startDatum, endDatum, ...rest } = parsed.data;
        const medication = await prisma.medication.update({
          where: { id: request.params.id },
          data: {
            ...rest,
            ...(startDatum && { startDatum: new Date(startDatum) }),
            ...(endDatum !== undefined && {
              endDatum: endDatum ? new Date(endDatum) : null,
            }),
          },
        });
        return reply.code(200).send({ success: true, medication });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Medication not found' });
        }
        throw err;
      }
    }
  );

  // DELETE /api/medications/:id — deactivate (set isActive = false)
  fastify.delete<{ Params: { id: string } }>(
    '/medications/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await prisma.medication.update({
          where: { id: request.params.id },
          data:  { isActive: false },
        });
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Medication not found' });
        }
        throw err;
      }
    }
  );
}
