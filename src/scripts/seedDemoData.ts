import prisma from '../db/prisma';
import bcrypt from 'bcrypt';
import {
  Role,
  Bewusstseinsstatus,
  Beatmungsmodus,
  LagerungsTyp,
  UrlaubStatus,
  KrankmeldungStatus,
  QualifikationTyp,
  TrainingStatus,
  ComplianceStatus,
  DocumentTyp,
  InvoiceStatus,
  RotaStatus,
  ShiftStatus,
  Schicht,
} from '@prisma/client';
import { checkAlerts } from '../lib/alertEngine';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, decimals = 1): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function mondayOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

async function findOrCreateUser(
  email: string,
  name: string,
  jobTitle: string,
  role: Role
): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing.id;

  const hashedPassword = await bcrypt.hash('12345678', 10);
  const user = await prisma.user.create({
    data: { email, password: hashedPassword, name, role, isActive: true },
  });

  await prisma.staff.create({
    data: { userId: user.id, jobTitle },
  });

  return user.id;
}

// ─── Main seed function ───────────────────────────────────────────────────────

export async function seedDemoData(): Promise<void> {

  // ── Staff users ────────────────────────────────────────────────────────────

  const luciaId  = await findOrCreateUser('lucia.bangura@airflow.de',  'Lucia Bangura',    'Examinierte Pflegefachkraft',   Role.PFLEGEKRAFT);
  const thomasId = await findOrCreateUser('thomas.meier@airflow.de',   'Thomas Meier',     'Pflegefachkraft Beatmung',       Role.PFLEGEKRAFT);
  const fatimaId = await findOrCreateUser('fatima.alhassan@airflow.de','Fatima Al-Hassan', 'Intensivpflegefachkraft',        Role.PFLEGEKRAFT);
  const klausId  = await findOrCreateUser('klaus.werner@airflow.de',   'Klaus Werner',     'Pflegehilfskraft',               Role.PFLEGEKRAFT);

  // ── PersonalAkten ──────────────────────────────────────────────────────────

  const personalAkteData = [
    { userId: luciaId,  eintrittsdatum: new Date('2023-03-01'), vertragTyp: 'Vollzeit', wochenstunden: 40, urlaubstageJahr: 30, resturlaub: 12 },
    { userId: thomasId, eintrittsdatum: new Date('2023-08-15'), vertragTyp: 'Vollzeit', wochenstunden: 40, urlaubstageJahr: 28, resturlaub: 8  },
    { userId: fatimaId, eintrittsdatum: new Date('2024-01-10'), vertragTyp: 'Teilzeit', wochenstunden: 30, urlaubstageJahr: 28, resturlaub: 15 },
    { userId: klausId,  eintrittsdatum: new Date('2024-04-01'), vertragTyp: 'Teilzeit', wochenstunden: 30, urlaubstageJahr: 28, resturlaub: 5  },
  ];

  for (const akte of personalAkteData) {
    const exists = await prisma.personalAkte.findUnique({ where: { userId: akte.userId } });
    if (!exists) {
      await prisma.personalAkte.create({ data: akte });
    }
  }

  // ── Qualifikationen ────────────────────────────────────────────────────────

  const luciaQuals: { typ: QualifikationTyp; bestaetigt: boolean }[] = [
    { typ: QualifikationTyp.BEATMUNGSPFLEGE, bestaetigt: true },
    { typ: QualifikationTyp.TRACHEOSTOMA,    bestaetigt: true },
    { typ: QualifikationTyp.BTM_BERECHTIGUNG, bestaetigt: true },
    { typ: QualifikationTyp.ERSTE_HILFE,     bestaetigt: true },
  ];

  for (const q of luciaQuals) {
    const exists = await prisma.qualifikation.findFirst({ where: { userId: luciaId, typ: q.typ } });
    if (!exists) await prisma.qualifikation.create({ data: { userId: luciaId, ...q } });
  }

  const thomasQuals: { typ: QualifikationTyp; bestaetigt: boolean }[] = [
    { typ: QualifikationTyp.BEATMUNGSPFLEGE, bestaetigt: true  },
    { typ: QualifikationTyp.TRACHEOSTOMA,    bestaetigt: false },
  ];

  for (const q of thomasQuals) {
    const exists = await prisma.qualifikation.findFirst({ where: { userId: thomasId, typ: q.typ } });
    if (!exists) await prisma.qualifikation.create({ data: { userId: thomasId, ...q } });
  }

  // ── Urlaub Anträge ─────────────────────────────────────────────────────────

  const adminUser = await prisma.user.findUnique({ where: { email: 'admin@airflow.de' } });
  const adminId   = adminUser?.id ?? luciaId;

  const urlaubData = [
    {
      userId:  luciaId,
      vonDatum: new Date('2026-05-12'),
      bisDatum: new Date('2026-05-16'),
      tage:    5,
      status:  UrlaubStatus.GENEHMIGT,
      genehmigtvonId: adminId,
      genehmigAt: new Date('2026-04-01'),
    },
    {
      userId:  thomasId,
      vonDatum: new Date('2026-06-01'),
      bisDatum: new Date('2026-06-05'),
      tage:    5,
      status:  UrlaubStatus.BEANTRAGT,
    },
  ];

  for (const u of urlaubData) {
    const exists = await prisma.urlaubAntrag.findFirst({
      where: { userId: u.userId, vonDatum: u.vonDatum },
    });
    if (!exists) await prisma.urlaubAntrag.create({ data: u });
  }

  // ── Krankmeldung ───────────────────────────────────────────────────────────

  const kmExists = await prisma.krankmeldung.findFirst({
    where: { userId: klausId, vonDatum: new Date('2026-04-20') },
  });
  if (!kmExists) {
    await prisma.krankmeldung.create({
      data: {
        userId:  klausId,
        vonDatum: new Date('2026-04-20'),
        bisDatum: new Date('2026-04-22'),
        status:  KrankmeldungStatus.BEENDET,
        attest:  true,
      },
    });
  }

  // ── Patient: Hans Müller ───────────────────────────────────────────────────

  const hansMueller = await prisma.patient.findFirst({
    where: { vorname: 'Hans', nachname: 'Müller' },
  });
  if (!hansMueller) {
    console.log('[seedDemoData] Hans Müller not found — skipping shifts and monitoring');
    return;
  }

  // ── Rota + Shifts ──────────────────────────────────────────────────────────

  const now    = new Date();
  const monday = mondayOfWeek(now);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const existingRota = await prisma.rota.findFirst({
    where: {
      wocheVom: { gte: monday, lte: new Date(monday.getTime() + 60_000) },
    },
  });

  const rota = existingRota ?? await prisma.rota.create({
    data: {
      wocheVom:      monday,
      wocheBis:      sunday,
      status:        RotaStatus.VEROEFFENTLICHT,
      erstelltVonId: adminId,
    },
  });

  function shiftDay(offsetDays: number): Date {
    const d = new Date(monday);
    d.setDate(monday.getDate() + offsetDays);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function shiftTimes(datum: Date, schicht: Schicht): { startzeit: Date; endzeit: Date } {
    if (schicht === Schicht.TAG) {
      return {
        startzeit: new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate(), 6,  0, 0)),
        endzeit:   new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate(), 18, 0, 0)),
      };
    }
    return {
      startzeit: new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate(), 18, 0, 0)),
      endzeit:   new Date(Date.UTC(datum.getFullYear(), datum.getMonth(), datum.getDate() + 1, 6, 0, 0)),
    };
  }

  const shiftsToCreate = [
    { dayOffset: 0, schicht: Schicht.TAG,   userId: luciaId,  status: ShiftStatus.GEPLANT },
    { dayOffset: 0, schicht: Schicht.NACHT, userId: thomasId, status: ShiftStatus.GEPLANT },
    { dayOffset: 1, schicht: Schicht.TAG,   userId: fatimaId, status: ShiftStatus.GEPLANT },
    { dayOffset: 1, schicht: Schicht.NACHT, userId: luciaId,  status: ShiftStatus.GEPLANT },
    { dayOffset: 2, schicht: Schicht.TAG,   userId: thomasId, status: ShiftStatus.AKTIV,
      clockInAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), monday.getDate() + 2, 6, 0, 0)) },
    { dayOffset: 2, schicht: Schicht.NACHT, userId: klausId,  status: ShiftStatus.GEPLANT },
    { dayOffset: 3, schicht: Schicht.TAG,   userId: luciaId,  status: ShiftStatus.GEPLANT },
    { dayOffset: 4, schicht: Schicht.TAG,   userId: fatimaId, status: ShiftStatus.GEPLANT },
  ];

  for (const s of shiftsToCreate) {
    const datum = shiftDay(s.dayOffset);
    const exists = await prisma.shift.findFirst({
      where: { rotaId: rota.id, userId: s.userId, datum, schicht: s.schicht },
    });
    if (!exists) {
      const times = shiftTimes(datum, s.schicht);
      await prisma.shift.create({
        data: {
          rotaId:     rota.id,
          userId:     s.userId,
          patientId:  hansMueller.id,
          schicht:    s.schicht,
          datum,
          startzeit:  times.startzeit,
          endzeit:    times.endzeit,
          status:     s.status,
          clockInAt:  'clockInAt' in s ? s.clockInAt as Date : undefined,
        },
      });
    }
  }

  // ── Monitoring entries — last 3 days ───────────────────────────────────────

  const TAG_HOURS = [6, 8, 10, 12, 14, 16];

  for (let dayOffset = 2; dayOffset >= 0; dayOffset--) {
    const day = new Date(now);
    day.setDate(now.getDate() - dayOffset);

    for (const hour of TAG_HOURS) {
      const recordedAt = new Date(Date.UTC(
        day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0
      ));

      const exists = await prisma.monitoringEntry.findFirst({
        where: { patientId: hansMueller.id, recordedAt },
      });
      if (exists) continue;

      const herzfrequenz = rand(68, 88);
      const atemfrequenz = rand(14, 18);
      const blutdruckSys = rand(115, 135);
      const blutdruckDia = rand(70, 85);
      const spo2         = randFloat(94, 98);
      const temperatur   = randFloat(36.4, 37.2);
      const atemzugvolumen = rand(450, 550);
      const fio2         = randFloat(0.21, 0.30, 2);

      const alertResult = checkAlerts({ spo2, herzfrequenz, atemfrequenz, blutdruckSys, temperatur });

      const entry = await prisma.monitoringEntry.create({
        data: {
          patientId:       hansMueller.id,
          recordedById:    luciaId,
          recordedAt,
          herzfrequenz,
          atemfrequenz,
          blutdruckSys,
          blutdruckDia,
          spo2,
          temperatur,
          bewusstsein:     Bewusstseinsstatus.WACH,
          beatmungsmodus:  Beatmungsmodus.CPAP,
          lagerung:        LagerungsTyp.GRAD_30,
          atemzugvolumen,
          peep:            5.0,
          fio2,
          alertLevel:     alertResult.alertLevel,
          alertTriggered: alertResult.alertTriggered,
        },
      });

      if (alertResult.alerts.length > 0) {
        await Promise.all(alertResult.alerts.map(a =>
          prisma.monitoringAlert.create({
            data: {
              patientId:     hansMueller.id,
              entryId:       entry.id,
              parameter:     a.parameter,
              wert:          a.wert,
              schwellenwert: a.schwellenwert,
              alertLevel:    a.alertLevel,
            },
          })
        ));
      }
    }
  }

  // ── Training records ───────────────────────────────────────────────────────

  const trainingData = [
    { userId: luciaId,  bezeichnung: 'Beatmungspflege Zertifizierung', status: TrainingStatus.ABGESCHLOSSEN,
      abgeschlossenAm: new Date('2024-03-01'), gueltigBis: new Date('2027-03-01'), pflichtschulung: true },
    { userId: thomasId, bezeichnung: 'Tracheostoma Schulung', status: TrainingStatus.ABGESCHLOSSEN,
      abgeschlossenAm: new Date('2024-08-15'), gueltigBis: new Date('2026-08-15'), pflichtschulung: true },
    { userId: fatimaId, bezeichnung: 'MDK Qualitätsmanagement', status: TrainingStatus.AUSSTEHEND,
      pflichtschulung: false },
    // First aid for all staff — expiring soon
    { userId: luciaId,  bezeichnung: 'Erste Hilfe Auffrischung', status: TrainingStatus.ABGESCHLOSSEN,
      abgeschlossenAm: new Date('2025-06-30'), gueltigBis: new Date('2026-06-30'), pflichtschulung: true },
    { userId: thomasId, bezeichnung: 'Erste Hilfe Auffrischung', status: TrainingStatus.ABGESCHLOSSEN,
      abgeschlossenAm: new Date('2025-06-30'), gueltigBis: new Date('2026-06-30'), pflichtschulung: true },
    { userId: fatimaId, bezeichnung: 'Erste Hilfe Auffrischung', status: TrainingStatus.ABGESCHLOSSEN,
      abgeschlossenAm: new Date('2025-06-30'), gueltigBis: new Date('2026-06-30'), pflichtschulung: true },
    { userId: klausId,  bezeichnung: 'Erste Hilfe Auffrischung', status: TrainingStatus.ABGESCHLOSSEN,
      abgeschlossenAm: new Date('2025-06-30'), gueltigBis: new Date('2026-06-30'), pflichtschulung: true },
  ];

  for (const t of trainingData) {
    const exists = await prisma.trainingRecord.findFirst({
      where: { userId: t.userId, bezeichnung: t.bezeichnung },
    });
    if (!exists) await prisma.trainingRecord.create({ data: t });
  }

  // ── Compliance checks ──────────────────────────────────────────────────────

  const complianceData = [
    { bezeichnung: 'Pflegedokumentation aktuell',         status: ComplianceStatus.KONFORM,      mdkRelevant: true },
    { bezeichnung: 'Beatmungsgeräte Wartungsnachweis',    status: ComplianceStatus.FAELLIG,      mdkRelevant: true, faelligAm: new Date('2026-05-15') },
    { bezeichnung: 'Mitarbeiter Qualifikationsnachweise', status: ComplianceStatus.KONFORM,      mdkRelevant: true },
    { bezeichnung: 'Notfallplan aktualisiert',            status: ComplianceStatus.UEBERFAELLIG, mdkRelevant: true, faelligAm: new Date('2026-04-01') },
    { bezeichnung: 'Hygieneplan überprüft',               status: ComplianceStatus.FAELLIG,      mdkRelevant: true, faelligAm: new Date('2026-05-30') },
  ];

  for (const c of complianceData) {
    const exists = await prisma.complianceCheck.findFirst({ where: { bezeichnung: c.bezeichnung } });
    if (!exists) await prisma.complianceCheck.create({ data: c });
  }

  // ── Staff documents for Lucia ──────────────────────────────────────────────

  const docData = [
    { typ: DocumentTyp.FUEHRUNGSZEUGNIS,   bezeichnung: 'Führungszeugnis',
      ausstellungsdatum: new Date('2024-01-15'), ablaufdatum: new Date('2027-01-15'), verifiziert: true },
    { typ: DocumentTyp.AUSBILDUNGSNACHWEIS, bezeichnung: 'Ausbildungsnachweis Krankenpflege',
      ausstellungsdatum: new Date('2018-06-30'), verifiziert: true },
    { typ: DocumentTyp.IMPFNACHWEIS,       bezeichnung: 'Impfnachweis',
      ausstellungsdatum: new Date('2023-11-01'), ablaufdatum: new Date('2025-11-01'), verifiziert: true },
  ];

  for (const d of docData) {
    const exists = await prisma.staffDocument.findFirst({
      where: { userId: luciaId, typ: d.typ },
    });
    if (!exists) await prisma.staffDocument.create({ data: { userId: luciaId, ...d } });
  }

  // ── Demo invoice ───────────────────────────────────────────────────────────

  const invoiceExists = await prisma.invoice.findUnique({ where: { rechnungsnummer: 'AF-2026-001' } });
  if (!invoiceExists) {
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const faellig      = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await prisma.invoice.create({
      data: {
        patientId:        hansMueller.id,
        rechnungsnummer:  'AF-2026-001',
        betrag:           4800.00,
        mwst:             0,
        status:           InvoiceStatus.VERSENDET,
        leistungsdatum:   firstOfMonth,
        faelligkeitsdatum: faellig,
        kostentraeger:    'AOK Rheinland',
        beschreibung:     'Ambulante Beatmungspflege April 2026',
        createdById:      adminId,
      },
    });
  }

  console.log('[airflow] Demo data seeded');
}
