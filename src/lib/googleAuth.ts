import prisma from '../db/prisma';

interface GoogleRefreshResponse {
  access_token: string;
  expires_in:   number;
}

export async function getGmailToken(userId: string): Promise<string> {
  const token = await prisma.googleToken.findUnique({ where: { userId } });
  if (!token) throw new Error('Gmail not connected. Visit /api/gmail/auth to connect.');

  if (token.expiresAt < new Date()) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: token.refreshToken ?? '',
        grant_type:    'refresh_token',
      }),
    });
    const data = await res.json() as GoogleRefreshResponse;
    await prisma.googleToken.update({
      where: { userId },
      data:  {
        accessToken: data.access_token,
        expiresAt:   new Date(Date.now() + data.expires_in * 1000),
      },
    });
    return data.access_token;
  }
  return token.accessToken;
}
