import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AlertLevel, Beatmungsmodus, Bewusstseinsstatus, LagerungsTyp, TrachealSekret } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';
import { checkAlerts, AlertDetail } from '../lib/alertEngine';

// ─── n8n webhook (fire-and-forget) ───────────────────────────────────────────

function fireN8nWebhook(payload: {
  type:       string;
  patientId:  string;
  entryId:    string;
  alerts:     AlertDetail[];
  recordedAt: Date;
}): void {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch((err) => console.error('[monitoring] n8n webhook failed:', err));
}

// ─── Zod schema ───────────────────────────────────────────────────────────────

const CreateEntrySchema = z.object({
  patientId:              z.string().min(1),
  recordedAt:             z.string().datetime(),
  herzfrequenz:           z.number().int().positive(),
  atemfrequenz:           z.number().int().positive(),
  blutdruckSys:           z.number().int().positive(),
  blutdruckDia:           z.number().int().positive(),
  spo2:                   z.number().min(0).max(100),
  temperatur:             z.number(),
  bewusstsein:            z.nativeEnum(Bewusstseinsstatus),
  beatmungsmodus:         z.nativeEnum(Beatmungsmodus),
  atemzugvolumen:         z.number().int().positive().optional(),
  peep:                   z.number().positive().optional(),
  fio2:                   z.number().min(0.21).max(1.0).optional(),
  spitzendruck:           z.number().positive().optional(),
  trachealSekret:         z.nativeEnum(TrachealSekret).optional(),
  absaugungDurchgefuehrt: z.boolean().default(false),
  cuffDruck:              z.number().positive().optional(),
  lagerung:               z.nativeEnum(LagerungsTyp),
  lagerungswechsel:       z.boolean().default(false),
  ernaehrung:             z.string().optional(),
  ausscheidung:           z.string().optional(),
  bemerkungen:            z.string().optional(),
});

// ─── Time window helpers (UTC) ────────────────────────────────────────────────

function todayWindow(): { gte: Date; lte: Date } {
  const now = new Date();
  const gte = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { gte, lte: now };
}

function shiftWindow(schicht: 'TAG' | 'NACHT'): { gte: Date; lte: Date } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (schicht === 'TAG') {
    return {
      gte: new Date(Date.UTC(y, m, d,     6, 0, 0)),
      lte: new Date(Date.UTC(y, m, d,    18, 0, 0)),
    };
  }
  // NACHT: yesterday 18:00 → today 06:00
  const prev = new Date(Date.UTC(y, m, d - 1));
  return {
    gte: new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), prev.getUTCDate(), 18, 0, 0)),
    lte: new Date(Date.UTC(y, m, d, 6, 0, 0)),
  };
}

function currentShift(): 'TAG' | 'NACHT' {
  const h = new Date().getUTCHours();
  return h >= 6 && h < 18 ? 'TAG' : 'NACHT';
}

const TAG_HOURS   = Array.from({ length: 12 }, (_, i) => i + 6);          // 6..17
const NACHT_HOURS = [...Array.from({ length: 6 }, (_, i) => i + 18),      // 18..23
                      ...Array.from({ length: 6 }, (_, i) => i)];          // 0..5

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function monitoringRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/monitoring/entry
  fastify.post(
    '/monitoring/entry',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateEntrySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { recordedAt, ...rest } = parsed.data;
      const alertResult = checkAlerts({
        spo2:         rest.spo2,
        herzfrequenz: rest.herzfrequenz,
        atemfrequenz: rest.atemfrequenz,
        blutdruckSys: rest.blutdruckSys,
        temperatur:   rest.temperatur,
        spitzendruck: rest.spitzendruck,
      });

      const entry = await prisma.monitoringEntry.create({
        data: {
          ...rest,
          recordedById:   request.user!.id,
          recordedAt:     new Date(recordedAt),
          alertLevel:     alertResult.alertLevel,
          alertTriggered: alertResult.alertTriggered,
        },
      });

      if (alertResult.alerts.length > 0) {
        await Promise.all(
          alertResult.alerts.map(alert =>
            prisma.monitoringAlert.create({
              data: {
                patientId:     entry.patientId,
                entryId:       entry.id,
                parameter:     alert.parameter,
                wert:          alert.wert,
                schwellenwert: alert.schwellenwert,
                alertLevel:    alert.alertLevel,
              },
            })
          )
        );
      }

      if (alertResult.alertLevel === AlertLevel.ROT) {
        fireN8nWebhook({
          type:       'MONITORING_ALERT_ROT',
          patientId:  entry.patientId,
          entryId:    entry.id,
          alerts:     alertResult.alerts,
          recordedAt: entry.recordedAt,
        });
      }

      return reply.code(201).send({ success: true, data: { entry, alerts: alertResult.alerts } });
    }
  );

  // GET /api/monitoring/patient/:patientId/today
  fastify.get<{ Params: { patientId: string } }>(
    '/monitoring/patient/:patientId/today',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const window = todayWindow();
      const entries = await prisma.monitoringEntry.findMany({
        where:   { patientId: request.params.patientId, recordedAt: window },
        include: { alerts: true },
        orderBy: { recordedAt: 'asc' },
      });
      return reply.code(200).send({ success: true, entries });
    }
  );

  // GET /api/monitoring/patient/:patientId/shift?schicht=TAG|NACHT
  fastify.get<{ Params: { patientId: string } }>(
    '/monitoring/patient/:patientId/shift',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { schicht } = request.query as { schicht?: string };
      if (schicht !== 'TAG' && schicht !== 'NACHT') {
        return reply.code(400).send({ success: false, error: 'schicht must be TAG or NACHT' });
      }
      const window = shiftWindow(schicht);
      const entries = await prisma.monitoringEntry.findMany({
        where:   { patientId: request.params.patientId, recordedAt: window },
        include: { alerts: true },
        orderBy: { recordedAt: 'asc' },
      });
      return reply.code(200).send({ success: true, entries });
    }
  );

  // GET /api/monitoring/patient/:patientId/history?from=ISO&to=ISO
  fastify.get<{ Params: { patientId: string } }>(
    '/monitoring/patient/:patientId/history',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { from, to } = request.query as { from?: string; to?: string };
      if (!from || !to) {
        return reply.code(400).send({ success: false, error: 'from and to query params are required' });
      }
      const entries = await prisma.monitoringEntry.findMany({
        where:   { patientId: request.params.patientId, recordedAt: { gte: new Date(from), lte: new Date(to) } },
        include: { alerts: true },
        orderBy: { recordedAt: 'asc' },
      });
      return reply.code(200).send({ success: true, entries });
    }
  );

  // GET /api/monitoring/patient/:patientId/missing
  fastify.get<{ Params: { patientId: string } }>(
    '/monitoring/patient/:patientId/missing',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const schicht = currentShift();
      const window  = shiftWindow(schicht);
      const entries = await prisma.monitoringEntry.findMany({
        where:  { patientId: request.params.patientId, recordedAt: window },
        select: { recordedAt: true },
      });
      const coveredHours = new Set(entries.map(e => e.recordedAt.getUTCHours()));
      const expectedHours = schicht === 'TAG' ? TAG_HOURS : NACHT_HOURS;
      const missingHours  = expectedHours.filter(h => !coveredHours.has(h));
      return reply.code(200).send({ success: true, data: { schicht, missingHours } });
    }
  );

  // GET /api/monitoring/alerts/open — static segment, registered before /:id
  fastify.get(
    '/monitoring/alerts/open',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const alerts = await prisma.monitoringAlert.findMany({
        where:   { acknowledgedAt: null },
        include: {
          patient: { select: { id: true, vorname: true, nachname: true } },
          entry:   { select: { recordedAt: true, alertLevel: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, alerts });
    }
  );

  // PUT /api/monitoring/alerts/:id/acknowledge
  fastify.put<{ Params: { id: string } }>(
    '/monitoring/alerts/:id/acknowledge',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const alert = await prisma.monitoringAlert.update({
          where: { id: request.params.id },
          data:  { acknowledgedAt: new Date(), acknowledgedById: request.user!.id },
        });
        return reply.code(200).send({ success: true, alert });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Alert not found' });
        }
        throw err;
      }
    }
  );
}
