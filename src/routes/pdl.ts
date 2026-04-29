import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AlertLevel,
  ComplianceStatus,
  DeviceStatus,
  IncidentSeverity,
  IncidentStatus,
  InvoiceStatus,
  KrankmeldungStatus,
  PatientStatus,
  UebergabeStatus,
  UrlaubStatus,
} from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';
import { getOpenAI, hasOpenAI } from '../lib/openai';

const CommandSchema = z.object({
  command: z.string().min(1),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function pdlRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/pdl/briefing
  fastify.get(
    '/pdl/briefing',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now      = new Date();
      const in7Days  = new Date(Date.now() +  7 * 24 * 60 * 60 * 1000);
      const in14Days = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      const [
        offeneAlerts,
        kritischeVorfaelle,
        geraeteDefekt,
        fehlendeDokumente,
        offeneUebergaben,
        aktiveKrankmeldungen,
        offeneUrlaubsantraege,
        ueberfaelligeRechnungen,
        wartungFaellig,
        patienten,
      ] = await Promise.all([
        prisma.monitoringAlert.count({ where: { acknowledgedAt: null } }),
        prisma.incident.count({ where: { severity: IncidentSeverity.KRITISCH, status: IncidentStatus.OFFEN } }),
        prisma.device.count({ where: { status: DeviceStatus.DEFEKT } }),
        prisma.staffDocument.count({
          where: { AND: [{ ablaufdatum: { not: null } }, { ablaufdatum: { lte: in14Days } }] },
        }),
        prisma.handover.count({ where: { status: { not: UebergabeStatus.QUITTIERT } } }),
        prisma.krankmeldung.count({ where: { status: KrankmeldungStatus.AKTIV } }),
        prisma.urlaubAntrag.count({ where: { status: UrlaubStatus.BEANTRAGT } }),
        prisma.invoice.count({ where: { status: InvoiceStatus.UEBERFAELLIG } }),
        prisma.device.count({
          where: { AND: [{ naechsteWartung: { not: null } }, { naechsteWartung: { lte: in7Days } }] },
        }),
        prisma.patient.findMany({
          where:  { status: PatientStatus.AKTIV },
          select: { id: true, vorname: true, nachname: true, beatmungspflichtig: true, status: true },
        }),
      ]);

      return reply.code(200).send({
        success: true,
        briefing: {
          datum: now.toISOString().split('T')[0],
          offeneAlerts,
          kritischeVorfaelle,
          geraeteDefekt,
          fehlendeDokumente,
          offeneUebergaben,
          aktiveKrankmeldungen,
          offeneUrlaubsantraege,
          ueberfaelligeRechnungen,
          wartungFaellig,
          patienten,
        },
      });
    }
  );

  // POST /api/pdl/command — AI command interface
  fastify.post(
    '/pdl/command',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!hasOpenAI()) {
        return reply.code(503).send({ success: false, error: 'AI not available' });
      }
      const parsed = CommandSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const completion = await getOpenAI().chat.completions.create({
        model:      'gpt-4o',
        max_tokens: 1000,
        messages: [
          {
            role: 'system',
            content:
              'You are Donna, the AI assistant for airflow Fachpflegedienst in Krefeld, Germany. ' +
              'You assist the Pflegedienstleiterin R. Koroma with managing her ICU-grade home care service. ' +
              'You speak German. You are professional, precise and caring. ' +
              'You help with: patient summaries, staff planning, compliance questions, MDK preparation, shift handovers, documentation. ' +
              'Keep responses concise and actionable.',
          },
          { role: 'user', content: parsed.data.command },
        ],
      });
      const response = completion.choices[0]?.message?.content ?? '';
      return reply.code(200).send({ success: true, data: { response } });
    }
  );

  // GET /api/pdl/reports/weekly-summary
  fastify.get(
    '/pdl/reports/weekly-summary',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now        = new Date();
      const dayOfWeek  = now.getUTCDay();
      const offset     = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const weekStart  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
      const weekEnd    = new Date(weekStart);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

      const [
        neueVorfaelle,
        erledigteVorfaelle,
        monitoringEintraege,
        rotAlerts,
        gelbAlerts,
        neueKrankmeldungen,
        genehmigterUrlaub,
        offeneRechnungen,
        bezahlteRechnungen,
      ] = await Promise.all([
        prisma.incident.count({ where: { createdAt: { gte: weekStart, lt: weekEnd } } }),
        prisma.incident.count({ where: { status: IncidentStatus.GESCHLOSSEN, updatedAt: { gte: weekStart, lt: weekEnd } } }),
        prisma.monitoringEntry.count({ where: { recordedAt: { gte: weekStart, lt: weekEnd } } }),
        prisma.monitoringEntry.count({ where: { alertLevel: AlertLevel.ROT, recordedAt: { gte: weekStart, lt: weekEnd } } }),
        prisma.monitoringEntry.count({ where: { alertLevel: AlertLevel.GELB, recordedAt: { gte: weekStart, lt: weekEnd } } }),
        prisma.krankmeldung.count({ where: { createdAt: { gte: weekStart, lt: weekEnd } } }),
        prisma.urlaubAntrag.count({ where: { status: UrlaubStatus.GENEHMIGT, updatedAt: { gte: weekStart, lt: weekEnd } } }),
        prisma.invoice.count({ where: { status: { notIn: [InvoiceStatus.BEZAHLT, InvoiceStatus.STORNIERT] } } }),
        prisma.invoice.count({ where: { status: InvoiceStatus.BEZAHLT, updatedAt: { gte: weekStart, lt: weekEnd } } }),
      ]);

      const wocheEndDisplay = new Date(weekEnd.getTime() - 86400000);
      return reply.code(200).send({
        success: true,
        summary: {
          woche: `${weekStart.toISOString().split('T')[0]} – ${wocheEndDisplay.toISOString().split('T')[0]}`,
          neueVorfaelle,
          erledigteVorfaelle,
          monitoringEintraege,
          rotAlerts,
          gelbAlerts,
          neueKrankmeldungen,
          genehmigterUrlaub,
          offeneRechnungen,
          bezahlteRechnungen,
        },
      });
    }
  );

  // GET /api/pdl/reports/mdk-summary
  fastify.get(
    '/pdl/reports/mdk-summary',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now      = new Date();
      const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const [
        complianceKonform,
        complianceFaellig,
        complianceUeberfaellig,
        mdkRelevanteChecks,
        letztePruefung,
        offeneIncidents,
        dokumenteAblaufend,
      ] = await Promise.all([
        prisma.complianceCheck.count({ where: { status: ComplianceStatus.KONFORM } }),
        prisma.complianceCheck.count({ where: { status: ComplianceStatus.FAELLIG } }),
        prisma.complianceCheck.count({ where: { status: ComplianceStatus.UEBERFAELLIG } }),
        prisma.complianceCheck.count({ where: { mdkRelevant: true } }),
        prisma.complianceCheck.findFirst({
          where:   { status: ComplianceStatus.KONFORM, erledigtAm: { not: null } },
          orderBy: { erledigtAm: 'desc' },
          select:  { erledigtAm: true },
        }),
        prisma.incident.count({ where: { mdkMeldepflichtig: true, mdkGemeldetAt: null } }),
        prisma.staffDocument.count({
          where: { AND: [{ ablaufdatum: { not: null } }, { ablaufdatum: { gte: now, lte: in30Days } }] },
        }),
      ]);

      return reply.code(200).send({
        success: true,
        mdk: {
          complianceKonform,
          complianceFaellig,
          complianceUeberfaellig,
          mdkRelevanteChecks,
          letztesPruefungsdatum: letztePruefung?.erledigtAm ?? null,
          offeneIncidents,
          dokumenteAblaufend,
        },
      });
    }
  );
}
