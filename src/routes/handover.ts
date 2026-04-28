import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Schicht, UebergabeStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

// ─── n8n webhook (fire-and-forget) ───────────────────────────────────────────

function fireN8nWebhook(payload: {
  type:          string;
  patientId:     string;
  schicht:       string;
  erstelltVonId: string;
  createdAt:     Date;
}): void {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch((err) => console.error('[handover] n8n webhook failed:', err));
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const CreateHandoverSchema = z.object({
  patientId:       z.string().min(1),
  schicht:         z.nativeEnum(Schicht),
  schichtDatum:    z.string().datetime(),
  zusammenfassung: z.string().min(1),
  offenePunkte:    z.string().optional(),
  massnahmen:      z.string().optional(),
  dringend:        z.boolean().default(false),
});

const UpdateHandoverSchema = z.object({
  zusammenfassung: z.string().min(1).optional(),
  offenePunkte:    z.string().nullable().optional(),
  massnahmen:      z.string().nullable().optional(),
  dringend:        z.boolean().optional(),
});

const handoverInclude = {
  patient: { select: { id: true, vorname: true, nachname: true } },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function handoverRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/handover/open — static segment, registered before /:id
  fastify.get(
    '/handover/open',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const handovers = await prisma.handover.findMany({
        where:   { status: { not: UebergabeStatus.QUITTIERT } },
        include: handoverInclude,
        orderBy: { schichtDatum: 'asc' },
      });
      return reply.code(200).send({ success: true, handovers });
    }
  );

  // GET /api/handover/patient/:patientId/latest — most specific, before /patient/:patientId
  fastify.get<{ Params: { patientId: string } }>(
    '/handover/patient/:patientId/latest',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const handover = await prisma.handover.findFirst({
        where:   { patientId: request.params.patientId },
        include: handoverInclude,
        orderBy: { schichtDatum: 'desc' },
      });
      return reply.code(200).send({ success: true, handover });
    }
  );

  // GET /api/handover/patient/:patientId
  fastify.get<{ Params: { patientId: string } }>(
    '/handover/patient/:patientId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { schicht } = request.query as { schicht?: string };
      const where: Record<string, unknown> = { patientId: request.params.patientId };
      if (schicht) where.schicht = schicht;
      const handovers = await prisma.handover.findMany({
        where,
        include: handoverInclude,
        orderBy: { schichtDatum: 'desc' },
      });
      return reply.code(200).send({ success: true, handovers });
    }
  );

  // GET /api/handover/:id
  fastify.get<{ Params: { id: string } }>(
    '/handover/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const handover = await prisma.handover.findUnique({
        where:   { id: request.params.id },
        include: handoverInclude,
      });
      if (!handover) return reply.code(404).send({ success: false, error: 'Handover not found' });
      return reply.code(200).send({ success: true, handover });
    }
  );

  // POST /api/handover
  fastify.post(
    '/handover',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateHandoverSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { schichtDatum, ...rest } = parsed.data;
      const handover = await prisma.handover.create({
        data: {
          ...rest,
          erstelltVonId: request.user!.id,
          schichtDatum:  new Date(schichtDatum),
        },
        include: handoverInclude,
      });
      if (handover.dringend) {
        fireN8nWebhook({
          type:          'HANDOVER_DRINGEND',
          patientId:     handover.patientId,
          schicht:       handover.schicht,
          erstelltVonId: handover.erstelltVonId,
          createdAt:     new Date(),
        });
      }
      return reply.code(201).send({ success: true, handover });
    }
  );

  // PUT /api/handover/:id — only when status is ENTWURF
  fastify.put<{ Params: { id: string } }>(
    '/handover/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateHandoverSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const existing = await prisma.handover.findUnique({ where: { id: request.params.id } });
        if (!existing) return reply.code(404).send({ success: false, error: 'Handover not found' });
        if (existing.status !== UebergabeStatus.ENTWURF) {
          return reply.code(400).send({ success: false, error: 'Can only update handovers in ENTWURF status' });
        }
        const handover = await prisma.handover.update({
          where:   { id: request.params.id },
          data:    parsed.data,
          include: handoverInclude,
        });
        return reply.code(200).send({ success: true, handover });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Handover not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/handover/:id/abschliessen — ENTWURF → ABGESCHLOSSEN
  fastify.put<{ Params: { id: string } }>(
    '/handover/:id/abschliessen',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const existing = await prisma.handover.findUnique({ where: { id: request.params.id } });
      if (!existing) return reply.code(404).send({ success: false, error: 'Handover not found' });
      if (existing.status !== UebergabeStatus.ENTWURF) {
        return reply.code(400).send({ success: false, error: 'Handover must be in ENTWURF to complete' });
      }
      const handover = await prisma.handover.update({
        where:   { id: request.params.id },
        data:    { status: UebergabeStatus.ABGESCHLOSSEN },
        include: handoverInclude,
      });
      return reply.code(200).send({ success: true, handover });
    }
  );

  // PUT /api/handover/:id/quittieren — ABGESCHLOSSEN → QUITTIERT
  fastify.put<{ Params: { id: string } }>(
    '/handover/:id/quittieren',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const existing = await prisma.handover.findUnique({ where: { id: request.params.id } });
      if (!existing) return reply.code(404).send({ success: false, error: 'Handover not found' });
      if (existing.status !== UebergabeStatus.ABGESCHLOSSEN) {
        return reply.code(400).send({ success: false, error: 'Handover must be ABGESCHLOSSEN to acknowledge' });
      }
      const handover = await prisma.handover.update({
        where:   { id: request.params.id },
        data:    { status: UebergabeStatus.QUITTIERT, quittiertvonId: request.user!.id, quittierAtAt: new Date() },
        include: handoverInclude,
      });
      return reply.code(200).send({ success: true, handover });
    }
  );
}
