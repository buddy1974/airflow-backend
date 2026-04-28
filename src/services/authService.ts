import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import prisma from '../db/prisma';

function signAccessToken(user: { id: string; email: string; name: string; role: Role }) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '8h' },
  );
}

function refreshExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d;
}

export async function registerUser(name: string, email: string, password: string, role: Role) {
  const hashed = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: { name, email, password: hashed, role },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  });
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return { error: 'INVALID_CREDENTIALS' as const };
  if (!user.isActive) return { error: 'ACCOUNT_DISABLED' as const };

  const match = await bcrypt.compare(password, user.password);
  if (!match) return { error: 'INVALID_CREDENTIALS' as const };

  const accessToken = signAccessToken(user);

  // Rotate refresh token: invalidate all previous ones for this user then create new
  await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
  const { token: refreshToken } = await prisma.refreshToken.create({
    data: { userId: user.id, token: generateToken(), expiresAt: refreshExpiresAt() },
  });

  return {
    token: accessToken,
    refresh_token: refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const record = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });

  if (!record || record.expiresAt < new Date() || !record.user.isActive) {
    return { error: 'INVALID_REFRESH_TOKEN' as const };
  }

  const accessToken = signAccessToken(record.user);
  return {
    token: accessToken,
    user: { id: record.user.id, name: record.user.name, email: record.user.email, role: record.user.role },
  };
}

export async function logoutUser(refreshToken: string) {
  await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
}

function generateToken(): string {
  return [...Array(40)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}
