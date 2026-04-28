import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DeviceStatus, DeviceTyp } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

// ─── n8n webhook (fire-and-forget) ───────────────────────────────────────────

function fireN8nWebhook(payload: {
  type:        string;
  deviceId:    string;
  bezeichnung: string;
  patientId:   string | null;
  changedAt?:  Date;
  checkedAt?:  Date;
}): void {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch((err) => console.error('[devices] n8n webhook failed:', err));
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const CreateDeviceSchema = z.object({
  bezeichnung:       z.string().min(1),
  hersteller:        z.string().optional(),
  modell:            z.string().optional(),
  seriennummer:      z.string().optional(),
  typ:               z.nativeEnum(DeviceTyp),
  status:            z.nativeEnum(DeviceStatus).default('AKTIV'),
  anschaffungsdatum: z.string().datetime().optional(),
  naechsteWartung:   z.string().datetime().optional(),
  patientId:         z.string().optional(),
  locationId:        z.string().optional(),
  bemerkungen:       z.string().optional(),
});

const UpdateDeviceSchema = z.object({
  bezeichnung:       z.string().min(1).optional(),
  hersteller:        z.string().nullable().optional(),
  modell:            z.string().nullable().optional(),
  seriennummer:      z.string().nullable().optional(),
  typ:               z.nativeEnum(DeviceTyp).optional(),
  status:            z.nativeEnum(DeviceStatus).optional(),
  anschaffungsdatum: z.string().datetime().nullable().optional(),
  naechsteWartung:   z.string().datetime().nullable().optional(),
  patientId:         z.string().nullable().optional(),
  locationId:        z.string().nullable().optional(),
  bemerkungen:       z.string().nullable().optional(),
});

const CreateCheckSchema = z.object({
  funktionsfaehig: z.boolean().default(true),
  bemerkungen:     z.string().optional(),
});

// ─── Shared include ───────────────────────────────────────────────────────────

const deviceListInclude = {
  patient:  { select: { id: true, vorname: true, nachname: true } },
  location: { select: { id: true, name: true } },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function deviceRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/devices/maintenance-due — static segment, registered before /:id
  fastify.get(
    '/devices/maintenance-due',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const devices = await prisma.device.findMany({
        where: {
          AND: [
            { naechsteWartung: { not: null } },
            { naechsteWartung: { lte: in14Days } },
          ],
        },
        include: {
          patient: { select: { id: true, vorname: true, nachname: true } },
        },
        orderBy: { naechsteWartung: 'asc' },
      });
      return reply.code(200).send({ success: true, devices });
    }
  );

  // GET /api/devices/patient/:patientId — static 'patient' prefix, registered before /:id
  fastify.get<{ Params: { patientId: string } }>(
    '/devices/patient/:patientId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const devices = await prisma.device.findMany({
        where:   { patientId: request.params.patientId },
        include: {
          patient:  { select: { id: true, vorname: true, nachname: true } },
          location: { select: { id: true, name: true } },
          checks:   { orderBy: { checkedAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, devices });
    }
  );

  // GET /api/devices
  fastify.get(
    '/devices',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, typ, patientId } = request.query as {
        status?:    string;
        typ?:       string;
        patientId?: string;
      };

      const where: Record<string, unknown> = {};
      if (status)    where.status = status;
      if (typ)       where.typ = typ;
      if (patientId) where.patientId = patientId;

      const devices = await prisma.device.findMany({
        where,
        include: deviceListInclude,
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, devices });
    }
  );

  // GET /api/devices/:id/checks — registered before bare /:id to prevent ambiguity
  fastify.get<{ Params: { id: string } }>(
    '/devices/:id/checks',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const checks = await prisma.deviceCheck.findMany({
        where:   { deviceId: request.params.id },
        orderBy: { checkedAt: 'desc' },
      });
      return reply.code(200).send({ success: true, checks });
    }
  );

  // GET /api/devices/:id
  fastify.get<{ Params: { id: string } }>(
    '/devices/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const device = await prisma.device.findUnique({
        where:   { id: request.params.id },
        include: {
          patient:  { select: { id: true, vorname: true, nachname: true } },
          location: { select: { id: true, name: true } },
          checks:   { orderBy: { checkedAt: 'desc' }, take: 5 },
        },
      });
      if (!device) return reply.code(404).send({ success: false, error: 'Device not found' });
      return reply.code(200).send({ success: true, device });
    }
  );

  // POST /api/devices — ADMIN only
  fastify.post(
    '/devices',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateDeviceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { anschaffungsdatum, naechsteWartung, ...rest } = parsed.data;
        const device = await prisma.device.create({
          data: {
            ...rest,
            anschaffungsdatum: anschaffungsdatum ? new Date(anschaffungsdatum) : undefined,
            naechsteWartung:   naechsteWartung   ? new Date(naechsteWartung)   : undefined,
          },
          include: deviceListInclude,
        });
        return reply.code(201).send({ success: true, device });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'Seriennummer already exists' });
        }
        throw err;
      }
    }
  );

  // POST /api/devices/:id/check — ADMIN, PFLEGEKRAFT
  fastify.post<{ Params: { id: string } }>(
    '/devices/:id/check',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = CreateCheckSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const device = await prisma.device.findUnique({ where: { id: request.params.id } });
      if (!device) return reply.code(404).send({ success: false, error: 'Device not found' });

      const savedCheck = await prisma.deviceCheck.create({
        data: {
          deviceId:        device.id,
          checkedById:     request.user!.id,
          funktionsfaehig: parsed.data.funktionsfaehig,
          bemerkungen:     parsed.data.bemerkungen,
        },
      });

      if (!parsed.data.funktionsfaehig) {
        fireN8nWebhook({
          type:        'DEVICE_CHECK_FAILED',
          deviceId:    device.id,
          bezeichnung: device.bezeichnung,
          patientId:   device.patientId,
          checkedAt:   new Date(),
        });
      }

      return reply.code(201).send({ success: true, data: savedCheck });
    }
  );

  // PUT /api/devices/:id — ADMIN, PFLEGEKRAFT
  fastify.put<{ Params: { id: string } }>(
    '/devices/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateDeviceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { anschaffungsdatum, naechsteWartung, ...rest } = parsed.data;
        const device = await prisma.device.update({
          where: { id: request.params.id },
          data: {
            ...rest,
            ...(anschaffungsdatum !== undefined && {
              anschaffungsdatum: anschaffungsdatum ? new Date(anschaffungsdatum) : null,
            }),
            ...(naechsteWartung !== undefined && {
              naechsteWartung: naechsteWartung ? new Date(naechsteWartung) : null,
            }),
          },
          include: deviceListInclude,
        });

        if (parsed.data.status === DeviceStatus.DEFEKT) {
          fireN8nWebhook({
            type:        'DEVICE_DEFEKT',
            deviceId:    device.id,
            bezeichnung: device.bezeichnung,
            patientId:   device.patientId,
            changedAt:   new Date(),
          });
        }

        return reply.code(200).send({ success: true, device });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Device not found' });
        }
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'Seriennummer already exists' });
        }
        throw err;
      }
    }
  );

  // DELETE /api/devices/:id — soft delete (set status = EINGELAGERT), ADMIN only
  fastify.delete<{ Params: { id: string } }>(
    '/devices/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await prisma.device.update({
          where: { id: request.params.id },
          data:  { status: DeviceStatus.EINGELAGERT },
        });
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Device not found' });
        }
        throw err;
      }
    }
  );
}
