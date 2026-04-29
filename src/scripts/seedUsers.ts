import prisma from '../db/prisma'
import bcrypt from 'bcrypt'
import { Role } from '@prisma/client'

export async function seedUsers() {
  const existing = await prisma.user.findUnique({ where: { email: 'admin@airflow.de' } })
  if (existing) return

  const hashedPassword = await bcrypt.hash('12345678', 10)

  await prisma.user.createMany({
    data: [
      {
        email: 'admin@airflow.de',
        password: hashedPassword,
        name: 'R. Koroma',
        role: Role.ADMIN,
        isActive: true
      },
      {
        email: 'pflege@airflow.de',
        password: hashedPassword,
        name: 'Pflegekraft Test',
        role: Role.PFLEGEKRAFT,
        isActive: true
      }
    ]
  })

  console.log('Users seeded: admin@airflow.de + pflege@airflow.de')
}
