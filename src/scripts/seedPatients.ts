import prisma from '../db/prisma';
import { Pflegegrad, PatientStatus } from '@prisma/client';

export async function seedPatients() {
  const count = await prisma.patient.count();
  if (count > 0) return;

  await prisma.patient.createMany({
    data: [
      {
        vorname:            'Hans',
        nachname:           'Müller',
        geburtsdatum:       new Date('1955-03-14'),
        diagnoseHaupt:      'COPD Grad IV mit respiratorischer Insuffizienz',
        beatmungspflichtig: true,
        tracheostoma:       true,
        tracheostomaTyp:    'Silikon-Trachealkanüle 8.0mm',
        pflegegrad:         Pflegegrad.PG5,
        kostentraeger:      'AOK Rheinland',
        adresse:            'Musterstraße 12, 47799 Krefeld',
        status:             PatientStatus.AKTIV,
      },
      {
        vorname:            'Maria',
        nachname:           'Schmidt',
        geburtsdatum:       new Date('1962-07-22'),
        diagnoseHaupt:      'ALS (Amyotrophe Lateralsklerose)',
        beatmungspflichtig: true,
        tracheostoma:       false,
        pflegegrad:         Pflegegrad.PG4,
        kostentraeger:      'TK Techniker Krankenkasse',
        adresse:            'Gartenweg 5, 47798 Krefeld',
        status:             PatientStatus.AKTIV,
      },
    ],
  });

  console.log('[airflow] Test patients seeded');
}
