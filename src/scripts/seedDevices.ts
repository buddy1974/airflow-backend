import prisma from '../db/prisma';
import { DeviceTyp, DeviceStatus } from '@prisma/client';

export async function seedDevices() {
  const count = await prisma.device.count();
  if (count > 0) return;

  const patient = await prisma.patient.findFirst({
    where: { vorname: 'Hans', nachname: 'Müller' },
  });
  if (!patient) return;

  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const in60Days = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  await prisma.device.createMany({
    data: [
      {
        bezeichnung:     'Trilogy 100 Beatmungsgerät',
        hersteller:      'Philips Respironics',
        modell:          'Trilogy 100',
        typ:             DeviceTyp.BEATMUNG,
        status:          DeviceStatus.AKTIV,
        naechsteWartung: in30Days,
        patientId:       patient.id,
      },
      {
        bezeichnung:     'Sekret-Absauggerät Medela',
        hersteller:      'Medela',
        modell:          'Vario 18',
        typ:             DeviceTyp.ABSAUGUNG,
        status:          DeviceStatus.AKTIV,
        naechsteWartung: in60Days,
        patientId:       patient.id,
      },
    ],
  });

  console.log('[airflow] Test devices seeded');
}
