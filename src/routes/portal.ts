import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateAccessSchema = z.object({
  userId:    z.string().min(1),
  patientId: z.string().min(1),
});

const CreateMessageSchema = z.object({
  nachricht: z.string().min(1),
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function verifyAccess(userId: string, patientId: string): Promise<boolean> {
  const access = await prisma.angehoerigerAccess.findFirst({
    where: { userId, patientId, isActive: true },
  });
  return !!access;
}

export async function portalRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/portal/meine-patienten
  fastify.get(
    '/portal/meine-patienten',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const accesses = await prisma.angehoerigerAccess.findMany({
        where:   { userId: request.user!.id, isActive: true },
        include: {
          patient: {
            select: {
              id: true, vorname: true, nachname: true, geburtsdatum: true,
              diagnoseHaupt: true, pflegegrad: true, status: true,
            },
          },
        },
      });
      const patients = accesses.map(a => a.patient);
      return reply.code(200).send({ success: true, data: patients });
    }
  );

  // GET /api/portal/patient/:patientId/uebersicht
  fastify.get<{ Params: { patientId: string } }>(
    '/portal/patient/:patientId/uebersicht',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { patientId } = request.params;
      if (!(await verifyAccess(request.user!.id, patientId))) {
        return reply.code(403).send({ success: false, error: 'Kein Zugriff auf diesen Patienten' });
      }

      const [patient, latestEntry, activeMedCount, latestHandover] = await Promise.all([
        prisma.patient.findUnique({
          where:  { id: patientId },
          select: {
            id: true, vorname: true, nachname: true, geburtsdatum: true,
            diagnoseHaupt: true, pflegegrad: true, status: true, adresse: true,
            beatmungspflichtig: true, tracheostoma: true,
          },
        }),
        prisma.monitoringEntry.findFirst({
          where:   { patientId },
          orderBy: { recordedAt: 'desc' },
          select:  { recordedAt: true, spo2: true, herzfrequenz: true, temperatur: true, alertLevel: true },
        }),
        prisma.medication.count({ where: { patientId, isActive: true } }),
        prisma.handover.findFirst({
          where:   { patientId },
          orderBy: { schichtDatum: 'desc' },
          select:  { schicht: true, schichtDatum: true, zusammenfassung: true, status: true },
        }),
      ]);

      if (!patient) return reply.code(404).send({ success: false, error: 'Patient not found' });

      return reply.code(200).send({
        success: true,
        data:    { patient, latestEntry, activeMedCount, latestHandover },
      });
    }
  );

  // GET /api/portal/patient/:patientId/monitoring
  fastify.get<{ Params: { patientId: string } }>(
    '/portal/patient/:patientId/monitoring',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { patientId } = request.params;
      if (!(await verifyAccess(request.user!.id, patientId))) {
        return reply.code(403).send({ success: false, error: 'Kein Zugriff auf diesen Patienten' });
      }

      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const entries = await prisma.monitoringEntry.findMany({
        where:   { patientId, recordedAt: { gte: since } },
        select:  {
          recordedAt:   true,
          spo2:         true,
          herzfrequenz: true,
          temperatur:   true,
          alertLevel:   true,
          bewusstsein:  true,
        },
        orderBy: { recordedAt: 'asc' },
      });

      return reply.code(200).send({ success: true, data: entries });
    }
  );

  // GET /api/portal/patient/:patientId/medikamente
  fastify.get<{ Params: { patientId: string } }>(
    '/portal/patient/:patientId/medikamente',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { patientId } = request.params;
      if (!(await verifyAccess(request.user!.id, patientId))) {
        return reply.code(403).send({ success: false, error: 'Kein Zugriff auf diesen Patienten' });
      }

      const medications = await prisma.medication.findMany({
        where:   { patientId, isActive: true },
        select:  {
          id: true, wirkstoff: true, handelsname: true,
          staerke: true, dosierung: true, haeufigkeit: true,
          route: true, anweisung: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      return reply.code(200).send({ success: true, data: medications });
    }
  );

  // GET /api/portal/patient/:patientId/nachrichten
  fastify.get<{ Params: { patientId: string } }>(
    '/portal/patient/:patientId/nachrichten',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { patientId } = request.params;
      if (!(await verifyAccess(request.user!.id, patientId))) {
        return reply.code(403).send({ success: false, error: 'Kein Zugriff auf diesen Patienten' });
      }

      const messages = await prisma.familyMessage.findMany({
        where:   { patientId },
        orderBy: { createdAt: 'desc' },
      });

      // Mark unread care-team messages as read
      await prisma.familyMessage.updateMany({
        where: { patientId, isFromFamily: false, gelesen: false },
        data:  { gelesen: true },
      });

      return reply.code(200).send({ success: true, data: messages });
    }
  );

  // POST /api/portal/patient/:patientId/nachrichten
  fastify.post<{ Params: { patientId: string } }>(
    '/portal/patient/:patientId/nachrichten',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { patientId } = request.params;
      if (!(await verifyAccess(request.user!.id, patientId))) {
        return reply.code(403).send({ success: false, error: 'Kein Zugriff auf diesen Patienten' });
      }

      const parsed = CreateMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const message = await prisma.familyMessage.create({
        data: {
          patientId,
          vonUserId:    request.user!.id,
          nachricht:    parsed.data.nachricht,
          isFromFamily: true,
        },
      });

      return reply.code(201).send({ success: true, data: message });
    }
  );

  // GET /api/portal/patient/:patientId/nachrichten/ungelesen
  fastify.get<{ Params: { patientId: string } }>(
    '/portal/patient/:patientId/nachrichten/ungelesen',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { patientId } = request.params;
      if (!(await verifyAccess(request.user!.id, patientId))) {
        return reply.code(403).send({ success: false, error: 'Kein Zugriff auf diesen Patienten' });
      }

      const count = await prisma.familyMessage.count({
        where: { patientId, isFromFamily: false, gelesen: false },
      });

      return reply.code(200).send({ success: true, data: { count } });
    }
  );

  // POST /api/portal/access — ADMIN only
  fastify.post(
    '/portal/access',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateAccessSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const access = await prisma.angehoerigerAccess.create({
          data: parsed.data,
        });
        return reply.code(201).send({ success: true, data: access });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'Zugriff bereits vorhanden' });
        }
        throw err;
      }
    }
  );

  // DELETE /api/portal/access/:id — ADMIN only (soft deactivate)
  fastify.delete<{ Params: { id: string } }>(
    '/portal/access/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await prisma.angehoerigerAccess.update({
          where: { id: request.params.id },
          data:  { isActive: false },
        });
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Access record not found' });
        }
        throw err;
      }
    }
  );

  // POST /api/portal/patient/:patientId/nachricht-von-team
  fastify.post<{ Params: { patientId: string } }>(
    '/portal/patient/:patientId/nachricht-von-team',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const parsed = CreateMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const message = await prisma.familyMessage.create({
        data: {
          patientId:    request.params.patientId,
          vonUserId:    request.user!.id,
          nachricht:    parsed.data.nachricht,
          isFromFamily: false,
        },
      });

      return reply.code(201).send({ success: true, data: message });
    }
  );
}
