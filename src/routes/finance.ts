import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { InvoiceStatus, PayrollStatus, TransactionTyp } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const CreateInvoiceSchema = z.object({
  patientId:          z.string().min(1),
  betrag:             z.number().positive(),
  mwst:               z.number().min(0).default(0),
  leistungsdatum:     z.string().datetime(),
  faelligkeitsdatum:  z.string().datetime(),
  kostentraeger:      z.string().optional(),
  beschreibung:       z.string().optional(),
});

const UpdateInvoiceSchema = z.object({
  betrag:             z.number().positive().optional(),
  mwst:               z.number().min(0).optional(),
  status:             z.nativeEnum(InvoiceStatus).optional(),
  leistungsdatum:     z.string().datetime().optional(),
  faelligkeitsdatum:  z.string().datetime().optional(),
  kostentraeger:      z.string().nullable().optional(),
  beschreibung:       z.string().nullable().optional(),
});

const CreateTransactionSchema = z.object({
  typ:          z.nativeEnum(TransactionTyp),
  betrag:       z.number().positive(),
  beschreibung: z.string().min(1),
  kategorie:    z.string().optional(),
  datum:        z.string().datetime(),
});

const CreatePayrollSchema = z.object({
  userId:      z.string().min(1),
  monat:       z.number().int().min(1).max(12),
  jahr:        z.number().int().min(2020),
  grundgehalt: z.number().positive(),
  zuschlaege:  z.number().min(0).default(0),
  abzuege:     z.number().min(0).default(0),
});

const invoiceInclude = {
  patient: { select: { id: true, vorname: true, nachname: true } },
};

// ─── Rechnungsnummer generator ────────────────────────────────────────────────

async function generateRechnungsnummer(): Promise<string> {
  const year  = new Date().getFullYear();
  const count = await prisma.invoice.count();
  return `AF-${year}-${String(count + 1).padStart(3, '0')}`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function financeRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Invoices ──────────────────────────────────────────────────────────────

  // GET /api/invoices/overdue — static, registered before /:id
  fastify.get(
    '/invoices/overdue',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now = new Date();
      await prisma.invoice.updateMany({
        where: {
          status:            { notIn: [InvoiceStatus.BEZAHLT, InvoiceStatus.STORNIERT, InvoiceStatus.UEBERFAELLIG] },
          faelligkeitsdatum: { lt: now },
        },
        data: { status: InvoiceStatus.UEBERFAELLIG },
      });
      const invoices = await prisma.invoice.findMany({
        where:   { status: InvoiceStatus.UEBERFAELLIG },
        include: invoiceInclude,
        orderBy: { faelligkeitsdatum: 'asc' },
      });
      return reply.code(200).send({ success: true, invoices });
    }
  );

  // GET /api/invoices
  fastify.get(
    '/invoices',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, patientId } = request.query as { status?: string; patientId?: string };
      const where: Record<string, unknown> = {};
      if (status)    where.status = status;
      if (patientId) where.patientId = patientId;
      const invoices = await prisma.invoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, invoices });
    }
  );

  // GET /api/invoices/:id
  fastify.get<{ Params: { id: string } }>(
    '/invoices/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const invoice = await prisma.invoice.findUnique({
        where:   { id: request.params.id },
        include: invoiceInclude,
      });
      if (!invoice) return reply.code(404).send({ success: false, error: 'Invoice not found' });
      return reply.code(200).send({ success: true, invoice });
    }
  );

  // POST /api/invoices
  fastify.post(
    '/invoices',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateInvoiceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { leistungsdatum, faelligkeitsdatum, ...rest } = parsed.data;
        const rechnungsnummer = await generateRechnungsnummer();
        const invoice = await prisma.invoice.create({
          data: {
            ...rest,
            rechnungsnummer,
            leistungsdatum:    new Date(leistungsdatum),
            faelligkeitsdatum: new Date(faelligkeitsdatum),
            createdById:       request.user!.id,
          },
          include: invoiceInclude,
        });
        return reply.code(201).send({ success: true, invoice });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'Rechnungsnummer already exists' });
        }
        throw err;
      }
    }
  );

  // PUT /api/invoices/:id/mark-paid — registered before /:id to avoid ambiguity
  fastify.put<{ Params: { id: string } }>(
    '/invoices/:id/mark-paid',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const invoice = await prisma.invoice.update({
          where:   { id: request.params.id },
          data:    { status: InvoiceStatus.BEZAHLT, bezahltAm: new Date() },
          include: invoiceInclude,
        });
        return reply.code(200).send({ success: true, invoice });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Invoice not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/invoices/:id
  fastify.put<{ Params: { id: string } }>(
    '/invoices/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateInvoiceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { leistungsdatum, faelligkeitsdatum, ...rest } = parsed.data;
        const invoice = await prisma.invoice.update({
          where: { id: request.params.id },
          data:  {
            ...rest,
            ...(leistungsdatum    && { leistungsdatum:    new Date(leistungsdatum) }),
            ...(faelligkeitsdatum && { faelligkeitsdatum: new Date(faelligkeitsdatum) }),
          },
          include: invoiceInclude,
        });
        return reply.code(200).send({ success: true, invoice });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Invoice not found' });
        }
        throw err;
      }
    }
  );

  // ── Finance transactions ───────────────────────────────────────────────────

  // GET /api/finance/transactions
  fastify.get(
    '/finance/transactions',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { typ, from, to } = request.query as { typ?: string; from?: string; to?: string };
      const where: Record<string, unknown> = {};
      if (typ) where.typ = typ;
      if (from || to) {
        where.datum = {
          ...(from && { gte: new Date(from) }),
          ...(to   && { lte: new Date(to) }),
        };
      }
      const transactions = await prisma.financeTransaction.findMany({
        where,
        orderBy: { datum: 'desc' },
      });
      return reply.code(200).send({ success: true, transactions });
    }
  );

  // POST /api/finance/transactions
  fastify.post(
    '/finance/transactions',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateTransactionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { datum, ...rest } = parsed.data;
      const transaction = await prisma.financeTransaction.create({
        data: { ...rest, datum: new Date(datum), createdById: request.user!.id },
      });
      return reply.code(201).send({ success: true, transaction });
    }
  );

  // GET /api/finance/summary
  fastify.get(
    '/finance/summary',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [einnahmenResult, ausgabenResult, invoicesPending, invoicesOverdue] = await Promise.all([
        prisma.financeTransaction.aggregate({ where: { typ: TransactionTyp.EINNAHME }, _sum: { betrag: true } }),
        prisma.financeTransaction.aggregate({ where: { typ: TransactionTyp.AUSGABE  }, _sum: { betrag: true } }),
        prisma.invoice.count({ where: { status: { notIn: [InvoiceStatus.BEZAHLT, InvoiceStatus.STORNIERT] } } }),
        prisma.invoice.count({ where: { status: InvoiceStatus.UEBERFAELLIG } }),
      ]);
      const totalEinnahmen = einnahmenResult._sum.betrag ?? 0;
      const totalAusgaben  = ausgabenResult._sum.betrag  ?? 0;
      return reply.code(200).send({
        success: true,
        summary: {
          totalEinnahmen,
          totalAusgaben,
          balance:         totalEinnahmen - totalAusgaben,
          invoicesPending,
          invoicesOverdue,
        },
      });
    }
  );

  // ── Payroll ───────────────────────────────────────────────────────────────

  // GET /api/payroll
  fastify.get(
    '/payroll',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const records = await prisma.payrollRecord.findMany({
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: [{ jahr: 'desc' }, { monat: 'desc' }],
      });
      return reply.code(200).send({ success: true, records });
    }
  );

  // POST /api/payroll
  fastify.post(
    '/payroll',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreatePayrollSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { grundgehalt, zuschlaege, abzuege, ...rest } = parsed.data;
      const netto = grundgehalt + zuschlaege - abzuege;
      const record = await prisma.payrollRecord.create({
        data: { ...rest, grundgehalt, zuschlaege, abzuege, netto },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      return reply.code(201).send({ success: true, record });
    }
  );

  // PUT /api/payroll/:id/approve
  fastify.put<{ Params: { id: string } }>(
    '/payroll/:id/approve',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const record = await prisma.payrollRecord.update({
          where:   { id: request.params.id },
          data:    { status: PayrollStatus.GENEHMIGT, genehmigtvonId: request.user!.id, genehmigAt: new Date() },
          include: { user: { select: { id: true, name: true, email: true } } },
        });
        return reply.code(200).send({ success: true, record });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Payroll record not found' });
        }
        throw err;
      }
    }
  );

  // PUT /api/payroll/:id/mark-paid
  fastify.put<{ Params: { id: string } }>(
    '/payroll/:id/mark-paid',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const record = await prisma.payrollRecord.update({
          where:   { id: request.params.id },
          data:    { status: PayrollStatus.AUSGEZAHLT },
          include: { user: { select: { id: true, name: true, email: true } } },
        });
        return reply.code(200).send({ success: true, record });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Payroll record not found' });
        }
        throw err;
      }
    }
  );
}
