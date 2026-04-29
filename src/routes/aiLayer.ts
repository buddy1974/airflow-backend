import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import { getOpenAI } from '../lib/openai';
import prisma from '../db/prisma';

const MonitoringSummarySchema = z.object({
  patientId: z.string().min(1),
  schicht:   z.enum(['TAG', 'NACHT']),
  datum:     z.string().min(1),
});

const HandoverWriterSchema = z.object({
  patientId:   z.string().min(1),
  schicht:     z.string().min(1),
  datum:       z.string().min(1),
  zusatzinfo:  z.string().optional(),
});

const MdkWriterSchema = z.object({
  typ:     z.enum(['qualitaetsbericht', 'pflegebericht', 'vorfallbericht', 'massnahmenplan']),
  kontext: z.string().optional(),
});

const CareWriterSchema = z.object({
  patientId:  z.string().min(1),
  feldTyp:    z.enum(['pflegeziele', 'massnahmen', 'beatmungsplan', 'risikoeinschaetzung', 'ressourcen']),
  kontext:    z.string().optional(),
});

const PredictAlertSchema = z.object({
  patientId: z.string().min(1),
});

export async function aiLayerRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/ai/monitoring-summary
  fastify.post(
    '/ai/monitoring-summary',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = MonitoringSummarySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { patientId, schicht, datum } = parsed.data;
      const date = new Date(datum);
      const y = date.getUTCFullYear();
      const m = date.getUTCMonth();
      const d = date.getUTCDate();

      let gte: Date, lte: Date;
      if (schicht === 'TAG') {
        gte = new Date(Date.UTC(y, m, d,  6, 0, 0));
        lte = new Date(Date.UTC(y, m, d, 18, 0, 0));
      } else {
        gte = new Date(Date.UTC(y, m, d - 1, 18, 0, 0));
        lte = new Date(Date.UTC(y, m, d,      6, 0, 0));
      }

      const entries = await prisma.monitoringEntry.findMany({
        where:   { patientId, recordedAt: { gte, lte } },
        orderBy: { recordedAt: 'asc' },
      });

      if (entries.length === 0) {
        return reply.code(404).send({ success: false, error: 'Keine Einträge gefunden' });
      }

      const patient = await prisma.patient.findUnique({
        where:  { id: patientId },
        select: { vorname: true, nachname: true, diagnoseHaupt: true },
      });

      const entriesText = entries.map(e =>
        `${new Date(e.recordedAt).toISOString().substring(11, 16)} — HF: ${e.herzfrequenz}, AF: ${e.atemfrequenz}, RR: ${e.blutdruckSys}/${e.blutdruckDia}, SpO2: ${e.spo2}%, Temp: ${e.temperatur}°C, Bewusstsein: ${e.bewusstsein}, Beatmung: ${e.beatmungsmodus}${e.alertLevel !== 'GRUEN' ? ' ⚠️ Alert: ' + e.alertLevel : ''}`
      ).join('\n');

      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role:    'system',
            content: 'Du bist ein medizinischer Dokumentationsassistent für einen ambulanten Beatmungspflegedienst in Deutschland. Erstelle eine professionelle Schichtzusammenfassung auf Deutsch basierend auf den Vitalwerten und Pflegedaten. Halte dich an MDK-konforme Dokumentationsstandards. Sei präzise und klinisch.',
          },
          {
            role:    'user',
            content: `Patient: ${patient?.vorname} ${patient?.nachname}\nDiagnose: ${patient?.diagnoseHaupt}\nSchicht: ${schicht}, Datum: ${datum}\n\nVitalwerte:\n${entriesText}`,
          },
        ],
        max_tokens: 600,
      });

      const summary = response.choices[0].message.content?.trim() ?? '';
      return reply.code(200).send({ success: true, data: { summary } });
    }
  );

  // POST /api/ai/handover-writer
  fastify.post(
    '/ai/handover-writer',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = HandoverWriterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { patientId, schicht, datum, zusatzinfo } = parsed.data;
      const date = new Date(datum);
      const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const [patient, entries, openIncidents, activeMeds] = await Promise.all([
        prisma.patient.findUnique({
          where:  { id: patientId },
          select: { vorname: true, nachname: true, diagnoseHaupt: true, pflegegrad: true },
        }),
        prisma.monitoringEntry.findMany({
          where:   { patientId, recordedAt: { gte: dayStart, lte: dayEnd } },
          orderBy: { recordedAt: 'asc' },
          take:    12,
        }),
        prisma.incident.findMany({
          where:   { patientId, status: { not: 'GESCHLOSSEN' } },
          orderBy: { createdAt: 'desc' },
          take:    5,
          select:  { titel: true, severity: true, occurredAt: true },
        }),
        prisma.medication.findMany({
          where:   { patientId, isActive: true },
          select:  { wirkstoff: true, dosierung: true, haeufigkeit: true },
          take:    10,
        }),
      ]);

      const vitals = entries.map(e =>
        `${new Date(e.recordedAt).toISOString().substring(11, 16)}: HF ${e.herzfrequenz}, AF ${e.atemfrequenz}, RR ${e.blutdruckSys}/${e.blutdruckDia}, SpO2 ${e.spo2}%, Temp ${e.temperatur}°C`
      ).join('\n');

      const medList = activeMeds.map(m => `${m.wirkstoff} ${m.dosierung} ${m.haeufigkeit}`).join(', ');
      const incidentList = openIncidents.map(i => `[${i.severity}] ${i.titel}`).join('; ');

      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role:    'system',
            content: 'Du bist ein Pflegedokumentationsassistent. Schreibe einen professionellen Übergabebericht für die Intensivpflege auf Deutsch. Format: Zustand des Patienten, Vitalwerte-Zusammenfassung, besondere Vorkommnisse, offene Aufgaben, Empfehlungen für die nächste Schicht.',
          },
          {
            role:    'user',
            content: `Patient: ${patient?.vorname} ${patient?.nachname} (${patient?.pflegegrad})\nDiagnose: ${patient?.diagnoseHaupt}\nSchicht: ${schicht}, Datum: ${datum}\n\nVitalwerte:\n${vitals || 'Keine Einträge'}\n\nMedikamente: ${medList || 'keine'}\nOffene Vorfälle: ${incidentList || 'keine'}${zusatzinfo ? '\n\nZusatzinformationen: ' + zusatzinfo : ''}`,
          },
        ],
        max_tokens: 700,
      });

      const bericht = response.choices[0].message.content?.trim() ?? '';
      return reply.code(200).send({ success: true, data: { bericht } });
    }
  );

  // POST /api/ai/mdk-writer
  fastify.post(
    '/ai/mdk-writer',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = MdkWriterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { typ, kontext } = parsed.data;

      const typLabels: Record<string, string> = {
        qualitaetsbericht: 'Qualitätsbericht',
        pflegebericht:     'Pflegebericht',
        vorfallbericht:    'Vorfallbericht',
        massnahmenplan:    'Maßnahmenplan',
      };

      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role:    'system',
            content: 'Du bist ein MDK-Qualitätsmanagement-Experte für ambulante Intensivpflege in Deutschland. Erstelle professionelle MDK-konforme Dokumente auf Deutsch nach SGB XI/V Standards. Verwende offizielle Fachterminologie der deutschen Pflege.',
          },
          {
            role:    'user',
            content: `Dokumenttyp: ${typLabels[typ]}\n${kontext ? 'Kontext: ' + kontext : 'Erstelle ein Beispieldokument.'}`,
          },
        ],
        max_tokens: 1000,
      });

      const dokument = response.choices[0].message.content?.trim() ?? '';
      return reply.code(200).send({ success: true, data: { dokument } });
    }
  );

  // POST /api/ai/care-writer
  fastify.post(
    '/ai/care-writer',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CareWriterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { patientId, feldTyp, kontext } = parsed.data;

      const patient = await prisma.patient.findUnique({
        where:  { id: patientId },
        select: {
          vorname: true, nachname: true, diagnoseHaupt: true,
          pflegegrad: true, beatmungspflichtig: true, tracheostoma: true,
        },
      });

      if (!patient) return reply.code(404).send({ success: false, error: 'Patient not found' });

      const feldLabels: Record<string, string> = {
        pflegeziele:      'Pflegeziele',
        massnahmen:       'Pflegemaßnahmen',
        beatmungsplan:    'Beatmungsplan',
        risikoeinschaetzung: 'Risikoeinschätzung',
        ressourcen:       'Ressourcen und Fähigkeiten des Patienten',
      };

      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role:    'system',
            content: 'Du bist ein Pflegeplanungsassistent für ambulante Beatmungspflege. Erstelle professionelle, individuelle Pflegeplan-Textbausteine auf Deutsch. Orientiere dich an SIS und MDK-Standards.',
          },
          {
            role:    'user',
            content: `Patient: ${patient.vorname} ${patient.nachname}\nDiagnose: ${patient.diagnoseHaupt}\nPflegegrad: ${patient.pflegegrad}\nBeatmungspflichtig: ${patient.beatmungspflichtig ? 'ja' : 'nein'}\nTracheostoma: ${patient.tracheostoma ? 'ja' : 'nein'}\n\nErstelle: ${feldLabels[feldTyp]}${kontext ? '\n\nZusatzkontext: ' + kontext : ''}`,
          },
        ],
        max_tokens: 600,
      });

      const text = response.choices[0].message.content?.trim() ?? '';
      return reply.code(200).send({ success: true, data: { text } });
    }
  );

  // POST /api/ai/predict-alert
  fastify.post(
    '/ai/predict-alert',
    { preHandler: [authenticate, requireRole(['ADMIN', 'PFLEGEKRAFT'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = PredictAlertSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { patientId } = parsed.data;
      const entries = await prisma.monitoringEntry.findMany({
        where:   { patientId },
        orderBy: { recordedAt: 'desc' },
        take:    24,
        select:  {
          recordedAt: true, herzfrequenz: true, atemfrequenz: true,
          blutdruckSys: true, spo2: true, temperatur: true, alertLevel: true,
        },
      });

      if (entries.length < 3) {
        return reply.code(200).send({
          success: true,
          data:    { prediction: 'Nicht genug Daten', riskLevel: 'UNBEKANNT' },
        });
      }

      const trendText = entries.map(e =>
        `${new Date(e.recordedAt).toISOString().substring(0, 16)}: HF=${e.herzfrequenz} AF=${e.atemfrequenz} RR=${e.blutdruckSys} SpO2=${e.spo2}% T=${e.temperatur}°C Level=${e.alertLevel}`
      ).join('\n');

      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role:    'system',
            content: 'Du bist ein klinischer KI-Assistent für Intensivpflege. Analysiere die Vitalwert-Trends und schätze das Risiko ein. Antworte NUR mit JSON: { "riskLevel": "NIEDRIG"|"MITTEL"|"HOCH", "begruendung": string, "empfehlungen": string[] }',
          },
          {
            role:    'user',
            content: `Vitalwert-Verlauf (neueste zuerst):\n${trendText}`,
          },
        ],
        max_tokens: 400,
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0].message.content ?? '{}';
      let result: { riskLevel?: string; begruendung?: string; empfehlungen?: string[] } = {};
      try {
        result = JSON.parse(raw);
      } catch {
        result = { riskLevel: 'UNBEKANNT', begruendung: raw, empfehlungen: [] };
      }

      return reply.code(200).send({
        success: true,
        data: {
          riskLevel:    result.riskLevel    ?? 'UNBEKANNT',
          begruendung:  result.begruendung  ?? '',
          empfehlungen: result.empfehlungen ?? [],
        },
      });
    }
  );
}
