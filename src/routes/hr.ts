import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KrankmeldungStatus, QualifikationTyp, UrlaubStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

// ─── n8n webhook (fire-and-forget) ───────────────────────────────────────────

function fireN8nWebhook(payload: {
  type:     string;
  userId:   string;
  vonDatum: Date;
  createdAt: Date;
}): void {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch((err) => console.error('[hr] n8n webhook failed:', err));
}

// ─── Working day calculator (Mon–Fri) ────────────────────────────────────────

function calculateWorkingDays(from: Date, to: Date): number {
  let count = 0;
  const current = new Date(from);
  current.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  while (current <= end) {
    const day = current.getUTCDay();
    if (day >= 1 && day <= 5) count++;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return count;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const CreateUrlaubSchema = z.object({
  vonDatum:   z.string().datetime(),
  bisDatum:   z.string().datetime(),
  grund:      z.string().optional(),
  bemerkungen: z.string().optional(),
});

const CreateKrankmeldungSchema = z.object({
  userId:     z.string().min(1),
  vonDatum:   z.string().datetime(),
  diagnose:   z.string().optional(),
  attest:     z.boolean().default(false),
  bemerkungen: z.string().optional(),
});

const CreateQualifikationSchema = z.object({
  userId:      z.string().min(1),
  typ:         z.nativeEnum(QualifikationTyp),
  erworbenAm:  z.string().datetime().optional(),
  gueltigBis:  z.string().datetime().optional(),
  nachweisUrl: z.string().optional(),
});

const CreatePersonalakteSchema = z.object({
  userId:          z.string().min(1),
  eintrittsdatum:  z.string().datetime().optional(),
  probezeitEnde:   z.string().datetime().optional(),
  vertragTyp:      z.string().optional(),
  wochenstunden:   z.number().positive().optional(),
  urlaubstageJahr: z.number().int().positive().default(28),
  resturlaub:      z.number().int().min(0).default(0),
  tarifgruppe:     z.string().optional(),
  notizen:         z.string().optional(),
});

const UpdatePersonalakteSchema = z.object({
  eintrittsdatum:  z.string().datetime().nullable().optional(),
  probezeitEnde:   z.string().datetime().nullable().optional(),
  vertragTyp:      z.string().nullable().optional(),
  wochenstunden:   z.number().positive().nullable().optional(),
  urlaubstageJahr: z.number().int().positive().optional(),
  resturlaub:      z.number().int().min(0).optional(),
  tarifgruppe:     z.string().nullable().optional(),
  notizen:         z.string().nullable().optional(),
});

const userSelect = { id: true, name: true };

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function hrRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Dashboard ─────────────────────────────────────────────────────────────

  // GET /api/hr/dashboard
  fastify.get(
    '/hr/dashboard',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now      = new Date();
      const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const [
        totalMitarbeiter,
        aktiveKrankmeldungen,
        offeneUrlaubsantraege,
        ablaufendeQualifikationen,
        ablaufendeDokumente,
      ] = await Promise.all([
        prisma.user.count({ where: { isActive: true } }),
        prisma.krankmeldung.count({ where: { status: KrankmeldungStatus.AKTIV } }),
        prisma.urlaubAntrag.count({ where: { status: UrlaubStatus.BEANTRAGT } }),
        prisma.qualifikation.count({ where: { gueltigBis: { gte: now, lte: in30Days } } }),
        prisma.staffDocument.count({ where: { ablaufdatum: { gte: now, lte: in30Days } } }),
      ]);
      return reply.code(200).send({
        success: true,
        dashboard: { totalMitarbeiter, aktiveKrankmeldungen, offeneUrlaubsantraege, ablaufendeQualifikationen, ablaufendeDokumente },
      });
    }
  );

  // ── Urlaub ────────────────────────────────────────────────────────────────

  // GET /api/hr/urlaub/my — static 'my', registered before list
  fastify.get(
    '/hr/urlaub/my',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const antraege = await prisma.urlaubAntrag.findMany({
        where:   { userId: request.user!.id },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, antraege });
    }
  );

  // GET /api/hr/urlaub
  fastify.get(
    '/hr/urlaub',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, userId } = request.query as { status?: string; userId?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (userId) where.userId = userId;
      const antraege = await prisma.urlaubAntrag.findMany({
        where,
        include: { user: { select: userSelect } },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, antraege });
    }
  );

  // POST /api/hr/urlaub
  fastify.post(
    '/hr/urlaub',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateUrlaubSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const from = new Date(parsed.data.vonDatum);
      const to   = new Date(parsed.data.bisDatum);
      const tage = calculateWorkingDays(from, to);
      const antrag = await prisma.urlaubAntrag.create({
        data: {
          userId:   request.user!.id,
          vonDatum: from,
          bisDatum: to,
          tage,
          grund:      parsed.data.grund,
          bemerkungen: parsed.data.bemerkungen,
        },
      });
      return reply.code(201).send({ success: true, antrag });
    }
  );

  // PUT /api/hr/urlaub/:id/approve
  fastify.put<{ Params: { id: string } }>(
    '/hr/urlaub/:id/approve',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const antrag = await prisma.urlaubAntrag.update({
          where: { id: request.params.id },
          data:  { status: UrlaubStatus.GENEHMIGT, genehmigtvonId: request.user!.id, genehmigAt: new Date() },
        });
        await prisma.personalAkte.updateMany({
          where: { userId: antrag.userId },
          data:  { resturlaub: { decrement: antrag.tage } },
        });
        return reply.code(200).send({ success: true, antrag });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Leave request not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/hr/urlaub/:id/reject
  fastify.put<{ Params: { id: string } }>(
    '/hr/urlaub/:id/reject',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const antrag = await prisma.urlaubAntrag.update({
          where: { id: request.params.id },
          data:  { status: UrlaubStatus.ABGELEHNT },
        });
        return reply.code(200).send({ success: true, antrag });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Leave request not found' });
        }
        throw err;
      }
    }
  );

  // ── Krankmeldungen ────────────────────────────────────────────────────────

  // GET /api/hr/krankmeldungen
  fastify.get(
    '/hr/krankmeldungen',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, userId } = request.query as { status?: string; userId?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (userId) where.userId = userId;
      const krankmeldungen = await prisma.krankmeldung.findMany({
        where,
        include: { user: { select: userSelect } },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, krankmeldungen });
    }
  );

  // POST /api/hr/krankmeldungen
  fastify.post(
    '/hr/krankmeldungen',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateKrankmeldungSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { vonDatum, ...rest } = parsed.data;
      const meldung = await prisma.krankmeldung.create({
        data: { ...rest, vonDatum: new Date(vonDatum) },
      });
      fireN8nWebhook({
        type:     'KRANKMELDUNG_NEU',
        userId:   meldung.userId,
        vonDatum: meldung.vonDatum,
        createdAt: new Date(),
      });
      return reply.code(201).send({ success: true, meldung });
    }
  );

  // PUT /api/hr/krankmeldungen/:id/beenden
  fastify.put<{ Params: { id: string } }>(
    '/hr/krankmeldungen/:id/beenden',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const meldung = await prisma.krankmeldung.update({
          where: { id: request.params.id },
          data:  { status: KrankmeldungStatus.BEENDET, bisDatum: new Date() },
        });
        return reply.code(200).send({ success: true, meldung });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Krankmeldung not found' });
        }
        throw err;
      }
    }
  );

  // ── Qualifikationen ───────────────────────────────────────────────────────

  // GET /api/hr/qualifikationen/matrix — static 'matrix', registered before list
  fastify.get(
    '/hr/qualifikationen/matrix',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const users = await prisma.user.findMany({
        where:   { isActive: true },
        select:  { id: true, name: true, qualifikationen: true },
        orderBy: { name: 'asc' },
      });
      return reply.code(200).send({ success: true, users });
    }
  );

  // GET /api/hr/qualifikationen
  fastify.get(
    '/hr/qualifikationen',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId, typ } = request.query as { userId?: string; typ?: string };
      const where: Record<string, unknown> = {};
      if (userId) where.userId = userId;
      if (typ)    where.typ    = typ;
      const qualifikationen = await prisma.qualifikation.findMany({
        where,
        include: { user: { select: userSelect } },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, qualifikationen });
    }
  );

  // POST /api/hr/qualifikationen
  fastify.post(
    '/hr/qualifikationen',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateQualifikationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { erworbenAm, gueltigBis, ...rest } = parsed.data;
      const qualifikation = await prisma.qualifikation.create({
        data: {
          ...rest,
          erworbenAm: erworbenAm ? new Date(erworbenAm) : undefined,
          gueltigBis: gueltigBis ? new Date(gueltigBis) : undefined,
        },
        include: { user: { select: userSelect } },
      });
      return reply.code(201).send({ success: true, qualifikation });
    }
  );

  // PUT /api/hr/qualifikationen/:id/bestaetigen
  fastify.put<{ Params: { id: string } }>(
    '/hr/qualifikationen/:id/bestaetigen',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const qualifikation = await prisma.qualifikation.update({
          where:   { id: request.params.id },
          data:    { bestaetigt: true },
          include: { user: { select: userSelect } },
        });
        return reply.code(200).send({ success: true, qualifikation });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Qualifikation not found' });
        }
        throw err;
      }
    }
  );

  // ── Personalakte ──────────────────────────────────────────────────────────

  // POST /api/hr/personalakte — registered before /:userId to avoid conflict
  fastify.post(
    '/hr/personalakte',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreatePersonalakteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { eintrittsdatum, probezeitEnde, ...rest } = parsed.data;
        const akte = await prisma.personalAkte.create({
          data: {
            ...rest,
            eintrittsdatum: eintrittsdatum ? new Date(eintrittsdatum) : undefined,
            probezeitEnde:  probezeitEnde  ? new Date(probezeitEnde)  : undefined,
          },
        });
        return reply.code(201).send({ success: true, akte });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'PersonalAkte already exists for this user' });
        }
        throw err;
      }
    }
  );

  // GET /api/hr/personalakte/:userId
  fastify.get<{ Params: { userId: string } }>(
    '/hr/personalakte/:userId',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const akte = await prisma.personalAkte.findUnique({
        where: { userId: request.params.userId },
      });
      if (!akte) return reply.code(404).send({ success: false, error: 'PersonalAkte not found' });

      const user = await prisma.user.findUnique({
        where:  { id: request.params.userId },
        select: {
          id:              true,
          name:            true,
          email:           true,
          role:            true,
          qualifikationen: true,
          urlaubAntraege:  { orderBy: { createdAt: 'desc' }, take: 5 },
          krankmeldungen:  { orderBy: { createdAt: 'desc' }, take: 5 },
          staffDocuments:  true,
          trainingRecords: true,
        },
      });
      return reply.code(200).send({ success: true, akte, user });
    }
  );

  // PUT /api/hr/personalakte/:userId
  fastify.put<{ Params: { userId: string } }>(
    '/hr/personalakte/:userId',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = UpdatePersonalakteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { eintrittsdatum, probezeitEnde, ...rest } = parsed.data;
        const akte = await prisma.personalAkte.update({
          where: { userId: request.params.userId },
          data:  {
            ...rest,
            ...(eintrittsdatum !== undefined && {
              eintrittsdatum: eintrittsdatum ? new Date(eintrittsdatum) : null,
            }),
            ...(probezeitEnde !== undefined && {
              probezeitEnde: probezeitEnde ? new Date(probezeitEnde) : null,
            }),
          },
        });
        return reply.code(200).send({ success: true, akte });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'PersonalAkte not found' });
        }
        throw err;
      }
    }
  );
}
