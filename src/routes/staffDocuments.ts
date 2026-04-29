import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DocumentTyp } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateStaffDocumentSchema = z.object({
  userId:            z.string().min(1),
  typ:               z.nativeEnum(DocumentTyp),
  bezeichnung:       z.string().min(1),
  ausstellungsdatum: z.string().datetime().optional(),
  ablaufdatum:       z.string().datetime().optional(),
  dokumentUrl:       z.string().optional(),
  bemerkungen:       z.string().optional(),
});

const UpdateStaffDocumentSchema = z.object({
  typ:               z.nativeEnum(DocumentTyp).optional(),
  bezeichnung:       z.string().min(1).optional(),
  ausstellungsdatum: z.string().datetime().nullable().optional(),
  ablaufdatum:       z.string().datetime().nullable().optional(),
  dokumentUrl:       z.string().nullable().optional(),
  verifiziert:       z.boolean().optional(),
  bemerkungen:       z.string().nullable().optional(),
});

const docInclude = {
  user: { select: { id: true, name: true } },
};

export async function staffDocumentRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/staff-documents/expiring — static, registered before /:id
  fastify.get(
    '/staff-documents/expiring',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now      = new Date();
      const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const documents = await prisma.staffDocument.findMany({
        where:   { ablaufdatum: { gte: now, lte: in30Days } },
        include: docInclude,
        orderBy: { ablaufdatum: 'asc' },
      });
      return reply.code(200).send({ success: true, documents });
    }
  );

  // GET /api/staff-documents/user/:userId — static 'user' prefix, before /:id
  fastify.get<{ Params: { userId: string } }>(
    '/staff-documents/user/:userId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const documents = await prisma.staffDocument.findMany({
        where:   { userId: request.params.userId },
        include: docInclude,
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, documents });
    }
  );

  // GET /api/staff-documents
  fastify.get(
    '/staff-documents',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId, typ } = request.query as { userId?: string; typ?: string };
      const where: Record<string, unknown> = {};
      if (userId) where.userId = userId;
      if (typ)    where.typ    = typ;
      const documents = await prisma.staffDocument.findMany({
        where,
        include: docInclude,
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, documents });
    }
  );

  // POST /api/staff-documents
  fastify.post(
    '/staff-documents',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateStaffDocumentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { ausstellungsdatum, ablaufdatum, ...rest } = parsed.data;
      const document = await prisma.staffDocument.create({
        data: {
          ...rest,
          ausstellungsdatum: ausstellungsdatum ? new Date(ausstellungsdatum) : undefined,
          ablaufdatum:       ablaufdatum       ? new Date(ablaufdatum)       : undefined,
        },
        include: docInclude,
      });
      return reply.code(201).send({ success: true, document });
    }
  );

  // PUT /api/staff-documents/:id/verify — registered before /:id
  fastify.put<{ Params: { id: string } }>(
    '/staff-documents/:id/verify',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const document = await prisma.staffDocument.update({
          where:   { id: request.params.id },
          data:    { verifiziert: true },
          include: docInclude,
        });
        return reply.code(200).send({ success: true, document });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Document not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/staff-documents/:id
  fastify.put<{ Params: { id: string } }>(
    '/staff-documents/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateStaffDocumentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { ausstellungsdatum, ablaufdatum, ...rest } = parsed.data;
        const document = await prisma.staffDocument.update({
          where: { id: request.params.id },
          data:  {
            ...rest,
            ...(ausstellungsdatum !== undefined && {
              ausstellungsdatum: ausstellungsdatum ? new Date(ausstellungsdatum) : null,
            }),
            ...(ablaufdatum !== undefined && {
              ablaufdatum: ablaufdatum ? new Date(ablaufdatum) : null,
            }),
          },
          include: docInclude,
        });
        return reply.code(200).send({ success: true, document });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Document not found' });
        }
        throw err;
      }
    }
  );

  // DELETE /api/staff-documents/:id — hard delete
  fastify.delete<{ Params: { id: string } }>(
    '/staff-documents/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await prisma.staffDocument.delete({ where: { id: request.params.id } });
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Document not found' });
        }
        throw err;
      }
    }
  );
}
