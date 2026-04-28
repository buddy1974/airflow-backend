import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RotaStatus, Schicht, ShiftStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

// ─── Shift time calculator ────────────────────────────────────────────────────

function calculateShiftTimes(datum: string, schicht: Schicht): { startzeit: Date; endzeit: Date } {
  const d   = new Date(datum);
  const y   = d.getUTCFullYear();
  const m   = d.getUTCMonth();
  const day = d.getUTCDate();

  if (schicht === Schicht.TAG) {
    return {
      startzeit: new Date(Date.UTC(y, m, day,     6, 0, 0)),
      endzeit:   new Date(Date.UTC(y, m, day,    18, 0, 0)),
    };
  }
  return {
    startzeit: new Date(Date.UTC(y, m, day,    18, 0, 0)),
    endzeit:   new Date(Date.UTC(y, m, day + 1,  6, 0, 0)),
  };
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const CreateRotaSchema = z.object({
  wocheVom: z.string().datetime(),
  wocheBis: z.string().datetime(),
});

const CreateShiftSchema = z.object({
  userId:      z.string().min(1),
  patientId:   z.string().min(1),
  schicht:     z.nativeEnum(Schicht),
  datum:       z.string().datetime(),
  bemerkungen: z.string().optional(),
});

const shiftUserPatientInclude = {
  user:    { select: { id: true, name: true } },
  patient: { select: { id: true, vorname: true, nachname: true } },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function rotaRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/rotas/current — static, registered before /:id
  fastify.get(
    '/rotas/current',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const today = new Date();
      const rota  = await prisma.rota.findFirst({
        where:   { wocheVom: { lte: today }, wocheBis: { gte: today } },
        include: { shifts: { include: shiftUserPatientInclude } },
      });
      return reply.code(200).send({ success: true, rota });
    }
  );

  // GET /api/rotas/shifts/my — static 'shifts', registered before parametric /:id
  fastify.get(
    '/rotas/shifts/my',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const shifts = await prisma.shift.findMany({
        where:   { userId: request.user!.id },
        include: {
          patient: { select: { id: true, vorname: true, nachname: true } },
          rota:    true,
        },
        orderBy: { datum: 'desc' },
      });
      return reply.code(200).send({ success: true, shifts });
    }
  );

  // GET /api/rotas/shifts/today
  fastify.get(
    '/rotas/shifts/today',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now        = new Date();
      const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const endOfDay   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
      const shifts     = await prisma.shift.findMany({
        where:   { datum: { gte: startOfDay, lte: endOfDay } },
        include: shiftUserPatientInclude,
        orderBy: { startzeit: 'asc' },
      });
      return reply.code(200).send({ success: true, shifts });
    }
  );

  // GET /api/rotas
  fastify.get(
    '/rotas',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const rotas = await prisma.rota.findMany({ orderBy: { wocheVom: 'desc' } });
      return reply.code(200).send({ success: true, rotas });
    }
  );

  // POST /api/rotas
  fastify.post(
    '/rotas',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateRotaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const rota = await prisma.rota.create({
        data: {
          wocheVom:      new Date(parsed.data.wocheVom),
          wocheBis:      new Date(parsed.data.wocheBis),
          erstelltVonId: request.user!.id,
        },
      });
      return reply.code(201).send({ success: true, rota });
    }
  );

  // PUT /api/rotas/:id/publish
  fastify.put<{ Params: { id: string } }>(
    '/rotas/:id/publish',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const rota = await prisma.rota.update({
          where: { id: request.params.id },
          data:  { status: RotaStatus.VEROEFFENTLICHT },
        });
        return reply.code(200).send({ success: true, rota });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Rota not found' });
        }
        throw err;
      }
    }
  );

  // POST /api/rotas/:id/shift — add shift to rota with conflict check
  fastify.post<{ Params: { id: string } }>(
    '/rotas/:id/shift',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = CreateShiftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const rota = await prisma.rota.findUnique({ where: { id: request.params.id } });
      if (!rota) return reply.code(404).send({ success: false, error: 'Rota not found' });

      const datumDate  = new Date(parsed.data.datum);
      const startOfDay = new Date(Date.UTC(datumDate.getUTCFullYear(), datumDate.getUTCMonth(), datumDate.getUTCDate()));
      const endOfDay   = new Date(Date.UTC(datumDate.getUTCFullYear(), datumDate.getUTCMonth(), datumDate.getUTCDate(), 23, 59, 59, 999));

      const conflict = await prisma.shift.findFirst({
        where: {
          userId:  parsed.data.userId,
          schicht: parsed.data.schicht,
          datum:   { gte: startOfDay, lte: endOfDay },
        },
      });
      if (conflict) {
        return reply.code(409).send({ success: false, error: 'Konflikt: Mitarbeiter bereits eingeplant' });
      }

      const { startzeit, endzeit } = calculateShiftTimes(parsed.data.datum, parsed.data.schicht);
      const shift = await prisma.shift.create({
        data: {
          rotaId:      request.params.id,
          userId:      parsed.data.userId,
          patientId:   parsed.data.patientId,
          schicht:     parsed.data.schicht,
          datum:       new Date(parsed.data.datum),
          startzeit,
          endzeit,
          bemerkungen: parsed.data.bemerkungen,
        },
        include: shiftUserPatientInclude,
      });
      return reply.code(201).send({ success: true, shift });
    }
  );

  // DELETE /api/rotas/:id/shift/:shiftId
  fastify.delete<{ Params: { id: string; shiftId: string } }>(
    '/rotas/:id/shift/:shiftId',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string; shiftId: string } }>, reply: FastifyReply) => {
      try {
        await prisma.shift.delete({ where: { id: request.params.shiftId } });
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Shift not found' });
        }
        throw err;
      }
    }
  );

  // POST /api/rotas/shifts/:shiftId/clock-in
  fastify.post<{ Params: { shiftId: string } }>(
    '/rotas/shifts/:shiftId/clock-in',
    { preHandler: [authenticate, requireRole(['PFLEGEKRAFT', 'ADMIN'])] },
    async (request: FastifyRequest<{ Params: { shiftId: string } }>, reply: FastifyReply) => {
      const shift = await prisma.shift.findUnique({ where: { id: request.params.shiftId } });
      if (!shift) return reply.code(404).send({ success: false, error: 'Shift not found' });

      if (request.user!.role !== 'ADMIN' && request.user!.id !== shift.userId) {
        return reply.code(403).send({ success: false, error: 'Not authorized to clock in for this shift' });
      }

      const updated = await prisma.shift.update({
        where:   { id: shift.id },
        data:    { clockInAt: new Date(), status: ShiftStatus.AKTIV },
        include: shiftUserPatientInclude,
      });
      return reply.code(200).send({ success: true, shift: updated });
    }
  );

  // POST /api/rotas/shifts/:shiftId/clock-out
  fastify.post<{ Params: { shiftId: string } }>(
    '/rotas/shifts/:shiftId/clock-out',
    { preHandler: [authenticate, requireRole(['PFLEGEKRAFT', 'ADMIN'])] },
    async (request: FastifyRequest<{ Params: { shiftId: string } }>, reply: FastifyReply) => {
      const shift = await prisma.shift.findUnique({ where: { id: request.params.shiftId } });
      if (!shift) return reply.code(404).send({ success: false, error: 'Shift not found' });
      if (shift.status !== ShiftStatus.AKTIV) {
        return reply.code(400).send({ success: false, error: 'Shift must be AKTIV to clock out' });
      }

      const updated = await prisma.shift.update({
        where:   { id: shift.id },
        data:    { clockOutAt: new Date(), status: ShiftStatus.ABGESCHLOSSEN },
        include: shiftUserPatientInclude,
      });
      return reply.code(200).send({ success: true, shift: updated });
    }
  );
}
