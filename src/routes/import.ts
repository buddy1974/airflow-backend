import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';
import * as xlsx from 'xlsx';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import {
  Beatmungsmodus,
  Bewusstseinsstatus,
  LagerungsTyp,
  MedicationRoute,
  Pflegegrad,
  Role,
} from '@prisma/client';
import { checkAlerts } from '../lib/alertEngine';

// ─── Multipart helpers ────────────────────────────────────────────────────────

async function readParts(
  request: FastifyRequest
): Promise<{ fileBuffer?: Buffer; fields: Record<string, string> }> {
  let fileBuffer: Buffer | undefined;
  const fields: Record<string, string> = {};

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      fileBuffer = await (part as { toBuffer(): Promise<Buffer> }).toBuffer();
    } else {
      fields[part.fieldname] = String((part as { value: unknown }).value ?? '');
    }
  }

  return { fileBuffer, fields };
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

const UBERWACHUNG_PARAMS: Record<string, string> = {
  'AZV/VTI Atemzugvolumen': 'atemzugvolumen',
  'V/VT Atemfrequenz':      'atemfrequenz',
  'Puls':                   'herzfrequenz',
  'RR':                     'blutdruckSys',
  'SpO2':                   'spo2',
  'Temperatur':              'temperatur',
  'Vigilanz Zustand':       'bewusstsein',
  'Cuffdruck':              'cuffDruck',
  'Summe Einfuhr':          'ernaehrung',
  'Summe Ausfuhr':          'ausscheidung',
};

function mapBewusstsein(val: string): Bewusstseinsstatus {
  const v = val.toUpperCase().trim();
  if (v === 'W' || v.startsWith('WACH'))  return Bewusstseinsstatus.WACH;
  if (v === 'S' || v.startsWith('SCHL'))  return Bewusstseinsstatus.SCHLAEFRIG;
  if (v.startsWith('SOM'))                return Bewusstseinsstatus.SOMNOLENT;
  if (v.startsWith('KOM'))                return Bewusstseinsstatus.KOMATOEES;
  return Bewusstseinsstatus.WACH;
}

function mapPflegegrad(val: string | number): Pflegegrad {
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  if (n >= 1 && n <= 5) return `PG${n}` as Pflegegrad;
  return Pflegegrad.PG3;
}

function mapMedRoute(val: string): MedicationRoute {
  const v = val.toLowerCase().trim();
  if (v === 'iv' || v.includes('intraven')) return MedicationRoute.INTRAVENOES;
  if (v.includes('inhal'))                  return MedicationRoute.INHALATIV;
  if (v.includes('subkut'))                 return MedicationRoute.SUBKUTAN;
  if (v.includes('sonde'))                  return MedicationRoute.SONDE;
  return MedicationRoute.ORAL;
}

function mapRole(val: string): Role {
  const v = val.toLowerCase().trim();
  if (v.includes('pdl') || v.includes('leitung') || v.includes('admin')) return Role.ADMIN;
  return Role.PFLEGEKRAFT;
}

function isTruthy(val: string | number | undefined): boolean {
  if (!val) return false;
  const v = String(val).toLowerCase().trim();
  return v === 'ja' || v === 'yes' || v === '1' || v === 'true';
}

function parseSysdia(val: unknown): { sys: number; dia: number } {
  const str = String(val ?? '');
  const parts = str.split('/');
  return {
    sys: parseInt(parts[0], 10) || 120,
    dia: parseInt(parts[1], 10) || 80,
  };
}

function findColIdx(headers: string[], ...candidates: string[]): number {
  for (const c of candidates) {
    const idx = headers.findIndex(h => h.includes(c.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseRows(buffer: Buffer): unknown[][] {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });
}

// ─── Template definitions ─────────────────────────────────────────────────────

const TEMPLATES: Record<string, { headers: string[]; example: (string | number)[] }> = {
  patienten: {
    headers: ['Vorname', 'Nachname', 'Geburtsdatum', 'Diagnose', 'Pflegegrad', 'Kostentraeger', 'Adresse', 'Beatmungspflichtig', 'Tracheostoma'],
    example: ['Hans', 'Müller', '1955-03-14', 'COPD Grad IV', 4, 'AOK Rheinland', 'Musterstr. 1, 47799 Krefeld', 'ja', 'nein'],
  },
  medikamente: {
    headers: ['Wirkstoff', 'Handelsname', 'Staerke', 'Dosierung', 'Haeufigkeit', 'Route', 'BtM'],
    example: ['Morphin', 'MST Retard', '10mg', '1 Tablette', '2x täglich', 'oral', 'ja'],
  },
  mitarbeiter: {
    headers: ['Vorname', 'Nachname', 'Email', 'Rolle', 'Position', 'Telefon'],
    example: ['Lucia', 'Bangura', 'lucia@airflow.de', 'Pflegekraft', 'Examinierte Pflegefachkraft', '0151 123456'],
  },
  uberwachungsprotokoll: {
    headers: ['Überwachungsprotokoll'],
    example: [''],
  },
};

// ─── Route registration ───────────────────────────────────────────────────────

export async function importRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/import/uberwachungsprotokoll
  fastify.post(
    '/import/uberwachungsprotokoll',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { fileBuffer, fields } = await readParts(request);
      if (!fileBuffer) return reply.code(400).send({ success: false, error: 'No file uploaded' });

      const patientId = fields.patientId;
      const schicht   = fields.schicht as 'TAG' | 'NACHT' | undefined;

      if (!patientId) return reply.code(400).send({ success: false, error: 'patientId is required' });
      if (schicht !== 'TAG' && schicht !== 'NACHT') {
        return reply.code(400).send({ success: false, error: 'schicht must be TAG or NACHT' });
      }

      const rows = parseRows(fileBuffer);
      if (rows.length < 5) {
        return reply.code(400).send({ success: false, error: 'Invalid Excel structure' });
      }

      // Row 2 (index 1): Name, Geb, Gewicht, Blatt-Nr, Datum
      const headerRow = rows[1] as unknown[];
      let importDate = new Date();
      for (let i = 0; i < headerRow.length; i++) {
        const cell = headerRow[i];
        if (cell instanceof Date) { importDate = cell; break; }
        if (typeof cell === 'string' && /\d{2}[.\-/]\d{2}[.\-/]\d{4}/.test(cell)) {
          importDate = new Date(cell.replace(/\./g, '-')); break;
        }
      }

      // Row 4 (index 3): time headers starting at column 3
      const timeRow = rows[3] as unknown[];
      const timeColumns: { index: number; hour: number }[] = [];
      for (let i = 3; i < timeRow.length; i++) {
        const match = String(timeRow[i] ?? '').match(/^(\d{1,2}):00/);
        if (match) timeColumns.push({ index: i, hour: parseInt(match[1], 10) });
      }

      // Collect param values per time slot
      const slots = new Map<number, Record<string, unknown>>();
      for (let rowIdx = 4; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx] as unknown[];
        const paramName = String(row[1] ?? '').trim();
        const dbField   = UBERWACHUNG_PARAMS[paramName];
        if (!dbField) continue;

        for (const { index, hour } of timeColumns) {
          const rawVal = row[index];
          if (rawVal === '' || rawVal === null || rawVal === undefined) continue;
          const slot = slots.get(hour) ?? {};
          slot[dbField] = rawVal;
          slots.set(hour, slot);
        }
      }

      let imported = 0, skipped = 0;
      const errors: string[] = [];
      const allAlerts: unknown[] = [];

      for (const [hour, params] of slots) {
        if (Object.keys(params).length === 0) continue;

        const recordedAt = new Date(Date.UTC(
          importDate.getUTCFullYear(),
          importDate.getUTCMonth(),
          importDate.getUTCDate(),
          hour, 0, 0
        ));

        const existing = await prisma.monitoringEntry.findFirst({ where: { patientId, recordedAt } });
        if (existing) { skipped++; continue; }

        try {
          const sysdia = parseSysdia(params.blutdruckSys);
          const herzfrequenz    = typeof params.herzfrequenz === 'number' ? Math.round(params.herzfrequenz as number) : 80;
          const atemfrequenz    = typeof params.atemfrequenz === 'number' ? Math.round(params.atemfrequenz as number) : 16;
          const spo2            = typeof params.spo2 === 'number' ? (params.spo2 as number) : parseFloat(String(params.spo2)) || 97;
          const temperatur      = typeof params.temperatur === 'number' ? (params.temperatur as number) : parseFloat(String(params.temperatur)) || 36.6;
          const cuffDruck       = params.cuffDruck != null ? parseFloat(String(params.cuffDruck)) : undefined;
          const atemzugvolumen  = params.atemzugvolumen != null ? Math.round(parseFloat(String(params.atemzugvolumen))) : undefined;
          const bewusstsein     = params.bewusstsein ? mapBewusstsein(String(params.bewusstsein)) : Bewusstseinsstatus.WACH;

          const alertResult = checkAlerts({ spo2, herzfrequenz, atemfrequenz, blutdruckSys: sysdia.sys, temperatur });

          const entry = await prisma.monitoringEntry.create({
            data: {
              patientId,
              recordedById:   request.user!.id,
              recordedAt,
              herzfrequenz,
              atemfrequenz,
              blutdruckSys:   sysdia.sys,
              blutdruckDia:   sysdia.dia,
              spo2,
              temperatur,
              bewusstsein,
              beatmungsmodus: Beatmungsmodus.CPAP,
              lagerung:       LagerungsTyp.RUECKENLAGE,
              alertLevel:     alertResult.alertLevel,
              alertTriggered: alertResult.alertTriggered,
              ...(cuffDruck      != null && { cuffDruck }),
              ...(atemzugvolumen != null && { atemzugvolumen }),
              ...(params.ernaehrung   ? { ernaehrung:   String(params.ernaehrung) }   : {}),
              ...(params.ausscheidung ? { ausscheidung: String(params.ausscheidung) } : {}),
            },
          });

          if (alertResult.alerts.length > 0) {
            await Promise.all(alertResult.alerts.map(a =>
              prisma.monitoringAlert.create({
                data: {
                  patientId,
                  entryId:       entry.id,
                  parameter:     a.parameter,
                  wert:          a.wert,
                  schwellenwert: a.schwellenwert,
                  alertLevel:    a.alertLevel,
                },
              })
            ));
            allAlerts.push(...alertResult.alerts.map(a => ({ hour, ...a })));
          }

          imported++;
        } catch (err) {
          errors.push(`Stunde ${hour}: ${(err as Error).message}`);
        }
      }

      return reply.code(200).send({ success: true, data: { imported, skipped, errors, alerts: allAlerts } });
    }
  );

  // POST /api/import/patienten
  fastify.post(
    '/import/patienten',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { fileBuffer } = await readParts(request);
      if (!fileBuffer) return reply.code(400).send({ success: false, error: 'No file uploaded' });

      const rows = parseRows(fileBuffer);
      if (rows.length < 2) return reply.code(400).send({ success: false, error: 'Empty file' });

      const headers = (rows[0] as unknown[]).map(c => String(c ?? '').trim().toLowerCase());
      let imported = 0, skipped = 0;
      const errors: string[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        try {
          const vorname   = String(row[findColIdx(headers, 'vorname', 'name')] ?? '').trim();
          const nachname  = String(row[findColIdx(headers, 'nachname')] ?? '').trim();
          const gebRaw    = row[findColIdx(headers, 'geburtsdatum', 'geb')];

          if (!vorname || !nachname || !gebRaw) { skipped++; continue; }

          const geburtsdatum = gebRaw instanceof Date ? gebRaw : new Date(String(gebRaw));
          if (isNaN(geburtsdatum.getTime())) { errors.push(`Zeile ${i + 1}: Ungültiges Geburtsdatum`); continue; }

          const existing = await prisma.patient.findFirst({
            where: { vorname, nachname, geburtsdatum },
          });
          if (existing) { skipped++; continue; }

          const pgRaw     = row[findColIdx(headers, 'pflegegrad', 'pg')];
          const beatmungRaw = row[findColIdx(headers, 'beatmung', 'beatmungspflichtig')];
          const trachoRaw = row[findColIdx(headers, 'tracheostoma')];

          await prisma.patient.create({
            data: {
              vorname,
              nachname,
              geburtsdatum,
              diagnoseHaupt:      String(row[findColIdx(headers, 'diagnose')] ?? 'Unbekannt'),
              pflegegrad:         pgRaw != null ? mapPflegegrad(pgRaw as string | number) : Pflegegrad.PG3,
              kostentraeger:      findColIdx(headers, 'kostentr', 'krankenkasse') >= 0
                                    ? String(row[findColIdx(headers, 'kostentr', 'krankenkasse')] ?? '')
                                    : undefined,
              adresse:            String(row[findColIdx(headers, 'adresse')] ?? 'Unbekannt'),
              beatmungspflichtig: isTruthy(beatmungRaw as string),
              tracheostoma:       isTruthy(trachoRaw as string),
            },
          });
          imported++;
        } catch (err) {
          errors.push(`Zeile ${i + 1}: ${(err as Error).message}`);
        }
      }

      return reply.code(200).send({ success: true, data: { imported, skipped, errors } });
    }
  );

  // POST /api/import/medikamente
  fastify.post(
    '/import/medikamente',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { fileBuffer, fields } = await readParts(request);
      if (!fileBuffer)        return reply.code(400).send({ success: false, error: 'No file uploaded' });
      if (!fields.patientId) return reply.code(400).send({ success: false, error: 'patientId is required' });

      const { patientId } = fields;
      const rows = parseRows(fileBuffer);
      if (rows.length < 2) return reply.code(400).send({ success: false, error: 'Empty file' });

      const headers = (rows[0] as unknown[]).map(c => String(c ?? '').trim().toLowerCase());
      let imported = 0, skipped = 0;
      const errors: string[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        try {
          const wirkstoff = String(row[findColIdx(headers, 'wirkstoff')] ?? '').trim();
          const staerke   = String(row[findColIdx(headers, 'stärke', 'staerke')] ?? '').trim();
          if (!wirkstoff || !staerke) { skipped++; continue; }

          const existing = await prisma.medication.findFirst({
            where: { wirkstoff, patientId, staerke },
          });
          if (existing) { skipped++; continue; }

          const routeRaw = row[findColIdx(headers, 'route')];

          await prisma.medication.create({
            data: {
              patientId,
              wirkstoff,
              staerke,
              handelsname: String(row[findColIdx(headers, 'handelsname')] ?? '') || undefined,
              dosierung:   String(row[findColIdx(headers, 'dosierung')] ?? '1x täglich'),
              haeufigkeit: String(row[findColIdx(headers, 'häufigkeit', 'haeufigkeit')] ?? '1x täglich'),
              route:       routeRaw ? mapMedRoute(String(routeRaw)) : MedicationRoute.ORAL,
              isBtm:       isTruthy(row[findColIdx(headers, 'btm', 'betäubungsmittel')] as string),
            },
          });
          imported++;
        } catch (err) {
          errors.push(`Zeile ${i + 1}: ${(err as Error).message}`);
        }
      }

      return reply.code(200).send({ success: true, data: { imported, skipped, errors } });
    }
  );

  // POST /api/import/mitarbeiter
  fastify.post(
    '/import/mitarbeiter',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { fileBuffer } = await readParts(request);
      if (!fileBuffer) return reply.code(400).send({ success: false, error: 'No file uploaded' });

      const rows = parseRows(fileBuffer);
      if (rows.length < 2) return reply.code(400).send({ success: false, error: 'Empty file' });

      const headers = (rows[0] as unknown[]).map(c => String(c ?? '').trim().toLowerCase());
      let imported = 0, skipped = 0;
      const errors: string[] = [];
      const credentials: { email: string; tempPassword: string }[] = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        try {
          const email = String(row[findColIdx(headers, 'email')] ?? '').trim().toLowerCase();
          if (!email) { skipped++; continue; }

          const existing = await prisma.user.findUnique({ where: { email } });
          if (existing) { skipped++; continue; }

          const vorname  = String(row[findColIdx(headers, 'vorname')] ?? '').trim();
          const nachname = String(row[findColIdx(headers, 'nachname')] ?? '').trim();
          const roleRaw  = row[findColIdx(headers, 'rolle', 'role')];

          const tempPassword   = crypto.randomBytes(16).toString('hex');
          const hashedPassword = await bcrypt.hash(tempPassword, 10);

          const user = await prisma.user.create({
            data: {
              email,
              password: hashedPassword,
              name:     `${vorname} ${nachname}`.trim() || email,
              role:     roleRaw ? mapRole(String(roleRaw)) : Role.PFLEGEKRAFT,
            },
          });

          await prisma.staff.create({
            data: {
              userId:   user.id,
              jobTitle: String(row[findColIdx(headers, 'position', 'jobtitel')] ?? 'Pflegekraft'),
              phone:    findColIdx(headers, 'telefon', 'tel') >= 0
                          ? String(row[findColIdx(headers, 'telefon', 'tel')] ?? '') || undefined
                          : undefined,
            },
          });

          credentials.push({ email, tempPassword });
          imported++;
        } catch (err) {
          errors.push(`Zeile ${i + 1}: ${(err as Error).message}`);
        }
      }

      return reply.code(200).send({ success: true, data: { imported, skipped, errors, credentials } });
    }
  );

  // POST /api/import/preview
  fastify.post(
    '/import/preview',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { fileBuffer, fields } = await readParts(request);
      if (!fileBuffer) return reply.code(400).send({ success: false, error: 'No file uploaded' });

      const rows = parseRows(fileBuffer);
      if (rows.length === 0) return reply.code(400).send({ success: false, error: 'Empty file' });

      const headers = (rows[0] as unknown[]).map(c => String(c ?? '').trim());
      const previewRows = rows.slice(1, 6).map(row =>
        (row as unknown[]).map(c => String(c ?? ''))
      );

      const typ = fields.typ ?? 'unknown';
      const templateHeaders = TEMPLATES[typ]?.headers ?? [];
      const warnings: string[] = [];

      const mappedColumns: Record<string, number> = {};
      for (const th of templateHeaders) {
        const idx = headers.findIndex(h => h.toLowerCase().includes(th.toLowerCase()));
        if (idx >= 0) {
          mappedColumns[th] = idx;
        } else {
          warnings.push(`Spalte "${th}" nicht gefunden`);
        }
      }

      return reply.code(200).send({
        success: true,
        data:    { headers, rows: previewRows, mappedColumns, warnings },
      });
    }
  );

  // GET /api/import/template/:typ
  fastify.get<{ Params: { typ: string } }>(
    '/import/template/:typ',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { typ: string } }>, reply: FastifyReply) => {
      const { typ } = request.params;
      const template = TEMPLATES[typ];
      if (!template) {
        return reply.code(400).send({ success: false, error: `Unknown template type: ${typ}` });
      }

      const wb = xlsx.utils.book_new();
      const ws = xlsx.utils.aoa_to_sheet([template.headers, template.example]);
      xlsx.utils.book_append_sheet(wb, ws, 'Template');
      const buf: Buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

      void reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      void reply.header('Content-Disposition', `attachment; filename="airflow_import_${typ}.xlsx"`);
      return reply.code(200).send(buf);
    }
  );
}
