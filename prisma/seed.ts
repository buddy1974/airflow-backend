import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Seed Krefeld HQ location
  const location = await prisma.location.upsert({
    where: { id: 'krefeld-hq' },
    update: {},
    create: {
      id:      'krefeld-hq',
      name:    'Krefeld — airflow Hauptsitz',
      address: 'Stephanstraße 7, 47799 Krefeld',
      phone:   '02151 / 65 99 998',
    },
  });
  console.log('Location seeded:', location.name);

  // Admin user — R. Koroma · PDL
  const adminPw = await bcrypt.hash('12345678', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@airflow.de' },
    update: {},
    create: {
      email:    'admin@airflow.de',
      password: adminPw,
      name:     'R. Koroma',
      role:     'ADMIN',
    },
  });
  console.log('Admin user seeded:', admin.email);

  // Test Pflegekraft
  const pflegePw = await bcrypt.hash('12345678', 10);
  const pflege = await prisma.user.upsert({
    where: { email: 'pflege@airflow.de' },
    update: {},
    create: {
      email:    'pflege@airflow.de',
      password: pflegePw,
      name:     'Test Pflegekraft',
      role:     'PFLEGEKRAFT',
    },
  });
  console.log('Pflegekraft user seeded:', pflege.email);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
