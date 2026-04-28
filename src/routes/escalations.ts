import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateEscalationSchema = z.object({
  title:       z.string().min(1),
  description: z.string().min(1),
  severity:    z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
});

function fireN8nWebhook(escalation: { id: string; title: string; severity: string; description: string }) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ escalation, timestamp: new Date() }),
  }).catch((err) => console.error('[escalations] n8n webhook failed:', err));
}

export async function escalationRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/escalations — open escalations
  fastify.get(
    '/api/escalations',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const escalations = await prisma.escalation.findMany({
        where: { status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, escalations });
    }
  );

  // POST /api/escalations — also fires n8n webhook
  fastify.post(
    '/api/escalations',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateEscalationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const escalation = await prisma.escalation.create({ data: parsed.data });

      fireN8nWebhook({
        id:          escalation.id,
        title:       escalation.title,
        severity:    escalation.severity,
        description: escalation.description,
      });

      return reply.code(201).send({ success: true, escalation });
    }
  );

  // PUT /api/escalations/:id/resolve — ADMIN only
  fastify.put<{ Params: { id: string } }>(
    '/api/escalations/:id/resolve',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const escalation = await prisma.escalation.update({
        where: { id: request.params.id },
        data:  { status: 'RESOLVED', resolvedAt: new Date() },
      });
      return reply.code(200).send({ success: true, escalation });
    }
  );
}
