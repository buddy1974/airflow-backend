import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PatientStatus, Pflegegrad } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreatePatientSchema = z.object({
  vorname:            z.string().min(1),
  nachname:           z.string().min(1),
  geburtsdatum:       z.string().datetime(),
  diagnoseHaupt:      z.string().min(1),
  beatmungspflichtig: z.boolean().default(false),
  tracheostoma:       z.boolean().default(false),
  tracheostomaTyp:    z.string().optional(),
  pflegegrad:         z.nativeEnum(Pflegegrad).default('PG3'),
  kostentraeger:      z.string().optional(),
  notfallkontaktName: z.string().optional(),
  notfallkontaktTel:  z.string().optional(),
  adresse:            z.string().min(1),
  locationId:         z.string().optional(),
  aufnahmedatum:      z.string().datetime().optional(),
  bemerkungen:        z.string().optional(),
});

const UpdatePatientSchema = z.object({
  vorname:            z.string().min(1).optional(),
  nachname:           z.string().min(1).optional(),
  geburtsdatum:       z.string().datetime().optional(),
  diagnoseHaupt:      z.string().min(1).optional(),
  beatmungspflichtig: z.boolean().optional(),
  tracheostoma:       z.boolean().optional(),
  tracheostomaTyp:    z.string().nullable().optional(),
  pflegegrad:         z.nativeEnum(Pflegegrad).optional(),
  kostentraeger:      z.string().nullable().optional(),
  notfallkontaktName: z.string().nullable().optional(),
  notfallkontaktTel:  z.string().nullable().optional(),
  adresse:            z.string().min(1).optional(),
  locationId:         z.string().nullable().optional(),
  entlassdatum:       z.string().datetime().nullable().optional(),
  status:             z.nativeEnum(PatientStatus).optional(),
  bemerkungen:        z.string().nullable().optional(),
});

const patientInclude = {
  location:    { select: { id: true, name: true } },
  carePlans:   { where: { isActive: true } },
  medications: { where: { isActive: true } },
};

export async function patientRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/patients
  fastify.get(
    '/patients',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, locationId, page, limit } = request.query as {
        status?: string;
        locationId?: string;
        page?: string;
        limit?: string;
      };

      const take = Math.min(Number(limit) || 20, 100);
      const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

      const where: Record<string, unknown> = {};
      if (status)     where.status = status;
      if (locationId) where.locationId = locationId;

      const [patients, total] = await Promise.all([
        prisma.patient.findMany({ where, include: patientInclude, skip, take, orderBy: { createdAt: 'desc' } }),
        prisma.patient.count({ where }),
      ]);

      return reply.code(200).send({ success: true, patients, total, page: Math.max(Number(page) || 1, 1), limit: take });
    }
  );

  // GET /api/patients/:id/summary — registered before /:id
  fastify.get<{ Params: { id: string } }>(
    '/patients/:id/summary',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const patient = await prisma.patient.findUnique({
        where: { id: request.params.id },
        select: {
          id: true, vorname: true, nachname: true, geburtsdatum: true,
          diagnoseHaupt: true, beatmungspflichtig: true, tracheostoma: true,
          tracheostomaTyp: true, pflegegrad: true, status: true, adresse: true,
          location: { select: { id: true, name: true } },
        },
      });
      if (!patient) return reply.code(404).send({ success: false, error: 'Patient not found' });
      return reply.code(200).send({ success: true, patient });
    }
  );

  // GET /api/patients/:id
  fastify.get<{ Params: { id: string } }>(
    '/patients/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const patient = await prisma.patient.findUnique({
        where: { id: request.params.id },
        include: patientInclude,
      });
      if (!patient) return reply.code(404).send({ success: false, error: 'Patient not found' });
      return reply.code(200).send({ success: true, patient });
    }
  );

  // POST /api/patients
  fastify.post(
    '/patients',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreatePatientSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { geburtsdatum, aufnahmedatum, ...rest } = parsed.data;
      const patient = await prisma.patient.create({
        data: {
          ...rest,
          geburtsdatum:  new Date(geburtsdatum),
          aufnahmedatum: aufnahmedatum ? new Date(aufnahmedatum) : undefined,
        },
        include: patientInclude,
      });
      return reply.code(201).send({ success: true, patient });
    }
  );

  // PUT /api/patients/:id
  fastify.put<{ Params: { id: string } }>(
    '/patients/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdatePatientSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { geburtsdatum, entlassdatum, ...rest } = parsed.data;
        const patient = await prisma.patient.update({
          where: { id: request.params.id },
          data: {
            ...rest,
            ...(geburtsdatum && { geburtsdatum: new Date(geburtsdatum) }),
            ...(entlassdatum !== undefined && {
              entlassdatum: entlassdatum ? new Date(entlassdatum) : null,
            }),
          },
          include: patientInclude,
        });
        return reply.code(200).send({ success: true, patient });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Patient not found' });
        }
        throw err;
      }
    }
  );

  // DELETE /api/patients/:id — soft delete (set status to ENTLASSEN)
  fastify.delete<{ Params: { id: string } }>(
    '/patients/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await prisma.patient.update({
          where: { id: request.params.id },
          data:  { status: PatientStatus.ENTLASSEN, entlassdatum: new Date() },
        });
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Patient not found' });
        }
        throw err;
      }
    }
  );
}
