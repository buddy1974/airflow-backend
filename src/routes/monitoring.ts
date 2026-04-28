import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AlertLevel,
  Beatmungsmodus,
  Bewusstseinsstatus,
  LagerungsTyp,
  TrachealSekret,
} from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';
import { getOpenAI, hasOpenAI } from '../lib/openai';

// ─── Alert threshold engine ───────────────────────────────────────────────────

interface AlertBreach {
  [key: string]:  string;
  parameter:      string;
  wert:           string;
  schwellenwert:  string;
  alertLevel:     string;
}

function detectAlerts(data: {
  herzfrequenz:   number;
  atemfrequenz:   number;
  blutdruckSys:   number;
  spo2:           number;
  temperatur:     number;
  trachealSekret?: TrachealSekret;
  bewusstsein:    Bewusstseinsstatus;
}): AlertBreach[] {
  const b: AlertBreach[] = [];

  if (data.spo2 < 90) {
    b.push({ parameter: 'spo2', wert: `${data.spo2}%`, schwellenwert: '< 90%', alertLevel: 'ROT' });
  } else if (data.spo2 < 94) {
    b.push({ parameter: 'spo2', wert: `${data.spo2}%`, schwellenwert: '< 94%', alertLevel: 'GELB' });
  }

  if (data.herzfrequenz < 50 || data.herzfrequenz > 130) {
    b.push({ parameter: 'herzfrequenz', wert: `${data.herzfrequenz}/min`, schwellenwert: '< 50 oder > 130/min', alertLevel: 'ROT' });
  } else if (data.herzfrequenz < 55 || data.herzfrequenz > 120) {
    b.push({ parameter: 'herzfrequenz', wert: `${data.herzfrequenz}/min`, schwellenwert: '< 55 oder > 120/min', alertLevel: 'GELB' });
  }

  if (data.atemfrequenz < 8 || data.atemfrequenz > 25) {
    b.push({ parameter: 'atemfrequenz', wert: `${data.atemfrequenz}/min`, schwellenwert: '< 8 oder > 25/min', alertLevel: 'ROT' });
  }

  if (data.blutdruckSys < 90 || data.blutdruckSys > 180) {
    b.push({ parameter: 'blutdruckSys', wert: `${data.blutdruckSys} mmHg`, schwellenwert: '< 90 oder > 180 mmHg', alertLevel: 'ROT' });
  } else if (data.blutdruckSys < 100 || data.blutdruckSys > 160) {
    b.push({ parameter: 'blutdruckSys', wert: `${data.blutdruckSys} mmHg`, schwellenwert: '< 100 oder > 160 mmHg', alertLevel: 'GELB' });
  }

  if (data.temperatur > 39.5) {
    b.push({ parameter: 'temperatur', wert: `${data.temperatur}°C`, schwellenwert: '> 39.5°C', alertLevel: 'ROT' });
  } else if (data.temperatur > 38.5) {
    b.push({ parameter: 'temperatur', wert: `${data.temperatur}°C`, schwellenwert: '> 38.5°C', alertLevel: 'GELB' });
  }

  if (data.trachealSekret === TrachealSekret.BLUTIG) {
    b.push({ parameter: 'trachealSekret', wert: 'BLUTIG', schwellenwert: 'BLUTIG', alertLevel: 'ROT' });
  } else if (data.trachealSekret === TrachealSekret.GRUENLICH) {
    b.push({ parameter: 'trachealSekret', wert: 'GRUENLICH', schwellenwert: 'GRUENLICH', alertLevel: 'GELB' });
  }

  if (data.bewusstsein === Bewusstseinsstatus.KOMATOEES) {
    b.push({ parameter: 'bewusstsein', wert: 'KOMATOEES', schwellenwert: 'KOMATOEES', alertLevel: 'ROT' });
  } else if (data.bewusstsein === Bewusstseinsstatus.SOMNOLENT) {
    b.push({ parameter: 'bewusstsein', wert: 'SOMNOLENT', schwellenwert: 'SOMNOLENT', alertLevel: 'GELB' });
  }

  return b;
}

function highestLevel(breaches: AlertBreach[]): AlertLevel {
  if (breaches.some(b => b.alertLevel === AlertLevel.ROT))  return AlertLevel.ROT;
  if (breaches.some(b => b.alertLevel === AlertLevel.GELB)) return AlertLevel.GELB;
  return AlertLevel.GRUEN;
}

function fireN8nWebhook(payload: {
  entryId: string; patientId: string; alertLevel: string; breaches: AlertBreach[];
}) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ monitoring: payload, timestamp: new Date() }),
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

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function monitoringRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Entries ──────────────────────────────────────────────────────────────

  // GET /api/monitoring/entries/patient/:patientId/latest
  fastify.get<{ Params: { patientId: string } }>(
    '/monitoring/entries/patient/:patientId/latest',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const entry = await prisma.monitoringEntry.findFirst({
        where:   { patientId: request.params.patientId },
        orderBy: { recordedAt: 'desc' },
        include: { alerts: true },
      });
      return reply.code(200).send({ success: true, entry });
    }
  );

  // GET /api/monitoring/entries/patient/:patientId
  fastify.get<{ Params: { patientId: string } }>(
    '/monitoring/entries/patient/:patientId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const { from, to, page, limit } = request.query as {
        from?: string; to?: string; page?: string; limit?: string;
      };

      const take = Math.min(Number(limit) || 24, 200);
      const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

      const where: Record<string, unknown> = { patientId: request.params.patientId };
      if (from || to) {
        where.recordedAt = {
          ...(from && { gte: new Date(from) }),
          ...(to   && { lte: new Date(to) }),
        };
      }

      const [entries, total] = await Promise.all([
        prisma.monitoringEntry.findMany({ where, include: { alerts: true }, skip, take, orderBy: { recordedAt: 'desc' } }),
        prisma.monitoringEntry.count({ where }),
      ]);

      return reply.code(200).send({ success: true, entries, total, page: Math.max(Number(page) || 1, 1), limit: take });
    }
  );

  // GET /api/monitoring/entries/:id
  fastify.get<{ Params: { id: string } }>(
    '/monitoring/entries/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const entry = await prisma.monitoringEntry.findUnique({
        where:   { id: request.params.id },
        include: { alerts: true },
      });
      if (!entry) return reply.code(404).send({ success: false, error: 'Entry not found' });
      return reply.code(200).send({ success: true, entry });
    }
  );

  // POST /api/monitoring/entries
  fastify.post(
    '/monitoring/entries',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateEntrySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { recordedAt, ...rest } = parsed.data;
      const breaches    = detectAlerts(rest);
      const alertLevel  = highestLevel(breaches);
      const alertTriggered = breaches.length > 0;

      const entry = await prisma.monitoringEntry.create({
        data: {
          ...rest,
          recordedById: request.user!.id,
          recordedAt:   new Date(recordedAt),
          alertLevel,
          alertTriggered,
        },
      });

      const alerts = await Promise.all(
        breaches.map(breach =>
          prisma.monitoringAlert.create({
            data: {
              patientId:     entry.patientId,
              entryId:       entry.id,
              parameter:     breach.parameter,
              wert:          breach.wert,
              schwellenwert: breach.schwellenwert,
              alertLevel:    breach.alertLevel as AlertLevel,
            },
          })
        )
      );

      if (alertLevel === AlertLevel.ROT) {
        await prisma.activityLog.create({
          data: {
            userId:   request.user!.id,
            action:   'ROT_ALERT_TRIGGERED',
            entity:   'MonitoringEntry',
            entityId: entry.id,
            metadata: { patientId: entry.patientId, breaches },
          },
        });
        fireN8nWebhook({ entryId: entry.id, patientId: entry.patientId, alertLevel: 'ROT', breaches });
      }

      return reply.code(201).send({ success: true, entry: { ...entry, alerts } });
    }
  );

  // POST /api/monitoring/entries/:id/analyse — OpenAI clinical assessment
  fastify.post<{ Params: { id: string } }>(
    '/monitoring/entries/:id/analyse',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!hasOpenAI()) {
        return reply.code(503).send({ success: false, error: 'AI analysis not available' });
      }

      const entry = await prisma.monitoringEntry.findUnique({
        where:   { id: request.params.id },
        include: { alerts: true },
      });
      if (!entry) return reply.code(404).send({ success: false, error: 'Entry not found' });

      const completion = await getOpenAI().chat.completions.create({
        model:      'gpt-4o',
        max_tokens: 400,
        messages: [
          {
            role:    'system',
            content: 'Du bist ein klinisches Entscheidungshilfssystem für Beatmungspflege (ICU-Ambulanz). ' +
                     'Analysiere die Monitoring-Daten kurz und präzise auf Deutsch. ' +
                     'Maximal 5 Sätze. Fokus: Auffälligkeiten, klinische Relevanz, empfohlene Maßnahmen.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              vitalzeichen: {
                herzfrequenz: entry.herzfrequenz,
                atemfrequenz: entry.atemfrequenz,
                blutdruckSys: entry.blutdruckSys,
                blutdruckDia: entry.blutdruckDia,
                spo2:         entry.spo2,
                temperatur:   entry.temperatur,
              },
              beatmung: {
                modus:          entry.beatmungsmodus,
                atemzugvolumen: entry.atemzugvolumen,
                peep:           entry.peep,
                fio2:           entry.fio2,
                spitzendruck:   entry.spitzendruck,
              },
              pflege: {
                bewusstsein:            entry.bewusstsein,
                trachealSekret:         entry.trachealSekret,
                absaugungDurchgefuehrt: entry.absaugungDurchgefuehrt,
                cuffDruck:              entry.cuffDruck,
                lagerung:               entry.lagerung,
              },
              alertLevel:   entry.alertLevel,
              aktiveAlerts: entry.alerts.map(a => ({
                parameter: a.parameter,
                wert:      a.wert,
                level:     a.alertLevel,
              })),
            }),
          },
        ],
      });

      const analyse = completion.choices[0]?.message?.content ?? '';
      return reply.code(200).send({ success: true, analyse });
    }
  );

  // ── Alerts ───────────────────────────────────────────────────────────────

  // GET /api/monitoring/alerts/unacknowledged — static, registered before /:id
  fastify.get(
    '/monitoring/alerts/unacknowledged',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const alerts = await prisma.monitoringAlert.findMany({
        where:   { acknowledgedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, alerts });
    }
  );

  // GET /api/monitoring/alerts/patient/:patientId
  fastify.get<{ Params: { patientId: string } }>(
    '/monitoring/alerts/patient/:patientId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const alerts = await prisma.monitoringAlert.findMany({
        where:   { patientId: request.params.patientId, acknowledgedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, alerts });
    }
  );

  // PUT /api/monitoring/alerts/:id/acknowledge
  fastify.put<{ Params: { id: string } }>(
    '/monitoring/alerts/:id/acknowledge',
    { preHandler: [authenticate] },
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
