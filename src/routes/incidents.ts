import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IncidentSeverity, IncidentStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

function fireN8nIncidentWebhook(incident: { id: string; titel: string; severity: string; patientId: string }) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ incident, timestamp: new Date() }),
  }).catch((err) => console.error('[incidents] n8n webhook failed:', err));
}

const CreateIncidentSchema = z.object({
  patientId:           z.string().min(1),
  titel:               z.string().min(1),
  beschreibung:        z.string().min(1),
  severity:            z.nativeEnum(IncidentSeverity).default('MITTEL'),
  geraetebeteiligt:    z.boolean().default(false),
  geraetBezeichnung:   z.string().optional(),
  massnahmenErgriffen: z.string().optional(),
  mdkMeldepflichtig:   z.boolean().default(false),
  occurredAt:          z.string().datetime(),
});

const UpdateIncidentSchema = z.object({
  titel:               z.string().min(1).optional(),
  beschreibung:        z.string().min(1).optional(),
  severity:            z.nativeEnum(IncidentSeverity).optional(),
  status:              z.nativeEnum(IncidentStatus).optional(),
  geraetebeteiligt:    z.boolean().optional(),
  geraetBezeichnung:   z.string().nullable().optional(),
  massnahmenErgriffen: z.string().nullable().optional(),
  mdkMeldepflichtig:   z.boolean().optional(),
  mdkGemeldetAt:       z.string().datetime().nullable().optional(),
  occurredAt:          z.string().datetime().optional(),
});

export async function incidentRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/incidents/mdk-pending — static segment, registered before /:id
  fastify.get(
    '/incidents/mdk-pending',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const incidents = await prisma.incident.findMany({
        where:   { mdkMeldepflichtig: true, mdkGemeldetAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, incidents });
    }
  );

  // GET /api/incidents/patient/:patientId — static 'patient' prefix, registered before /:id
  fastify.get<{ Params: { patientId: string } }>(
    '/incidents/patient/:patientId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { patientId: string } }>, reply: FastifyReply) => {
      const incidents = await prisma.incident.findMany({
        where:   { patientId: request.params.patientId },
        orderBy: { occurredAt: 'desc' },
      });
      return reply.code(200).send({ success: true, incidents });
    }
  );

  // GET /api/incidents
  fastify.get(
    '/incidents',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { patientId, severity, status } = request.query as {
        patientId?: string;
        severity?: string;
        status?: string;
      };

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (severity)  where.severity = severity;
      if (status)    where.status = status;

      const incidents = await prisma.incident.findMany({ where, orderBy: { createdAt: 'desc' } });
      return reply.code(200).send({ success: true, incidents });
    }
  );

  // GET /api/incidents/:id
  fastify.get<{ Params: { id: string } }>(
    '/incidents/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const incident = await prisma.incident.findUnique({ where: { id: request.params.id } });
      if (!incident) return reply.code(404).send({ success: false, error: 'Incident not found' });
      return reply.code(200).send({ success: true, incident });
    }
  );

  // POST /api/incidents
  fastify.post(
    '/incidents',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateIncidentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { occurredAt, ...rest } = parsed.data;
      const incident = await prisma.incident.create({
        data: {
          ...rest,
          reportedById: request.user!.id,
          occurredAt:   new Date(occurredAt),
        },
      });

      if (incident.severity === IncidentSeverity.KRITISCH) {
        await prisma.activityLog.create({
          data: {
            userId:   request.user!.id,
            action:   'KRITISCH_INCIDENT_CREATED',
            entity:   'Incident',
            entityId: incident.id,
            metadata: { titel: incident.titel, patientId: incident.patientId },
          },
        });
        fireN8nIncidentWebhook({
          id:        incident.id,
          titel:     incident.titel,
          severity:  incident.severity,
          patientId: incident.patientId,
        });
      }

      return reply.code(201).send({ success: true, incident });
    }
  );

  // PUT /api/incidents/:id
  fastify.put<{ Params: { id: string } }>(
    '/incidents/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateIncidentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { occurredAt, mdkGemeldetAt, ...rest } = parsed.data;
        const incident = await prisma.incident.update({
          where: { id: request.params.id },
          data: {
            ...rest,
            ...(occurredAt && { occurredAt: new Date(occurredAt) }),
            ...(mdkGemeldetAt !== undefined && {
              mdkGemeldetAt: mdkGemeldetAt ? new Date(mdkGemeldetAt) : null,
            }),
          },
        });
        return reply.code(200).send({ success: true, incident });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Incident not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/incidents/:id/resolve
  fastify.put<{ Params: { id: string } }>(
    '/incidents/:id/resolve',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const incident = await prisma.incident.update({
          where: { id: request.params.id },
          data:  { status: IncidentStatus.GESCHLOSSEN, resolvedAt: new Date() },
        });
        return reply.code(200).send({ success: true, incident });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Incident not found' });
        }
        throw err;
      }
    }
  );
}
