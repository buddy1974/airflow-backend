import prisma from '../db/prisma';

export async function seedLocation() {
  const existing = await prisma.location.findFirst({ where: { name: { contains: 'Krefeld' } } });
  if (existing) return;

  await prisma.location.create({
    data: {
      id:      'krefeld-hq',
      name:    'Krefeld — airflow Hauptsitz',
      address: 'Stephanstraße 7, 47799 Krefeld',
      phone:   '02151 / 65 99 998',
    },
  });

  console.log('[airflow] Krefeld HQ location seeded');
}
