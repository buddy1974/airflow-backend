import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';
import { getGmailToken } from '../lib/googleAuth';

// ─── Gmail API types ──────────────────────────────────────────────────────────

interface GmailMessageRef { id: string; threadId: string; }
interface GmailListResponse { messages?: GmailMessageRef[]; }
interface GmailHeader       { name: string; value: string; }
interface GmailMessage {
  id:           string;
  threadId?:    string;
  snippet?:     string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}

interface GoogleTokenExchangeResponse {
  access_token:   string;
  refresh_token?: string;
  expires_in:     number;
  token_type:     string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function getHeader(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function buildMimeMessage(to: string, subject: string, body: string): string {
  const raw = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  return Buffer.from(raw).toString('base64url');
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const SendSchema = z.object({
  to:      z.string().min(1),
  subject: z.string().min(1),
  body:    z.string().min(1),
});

const DraftSchema = z.object({
  to:      z.string().min(1),
  subject: z.string().min(1),
  body:    z.string().min(1),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function gmailRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/gmail/auth — generate OAuth URL
  fastify.get(
    '/gmail/auth',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const params = new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID!,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI!,
        response_type: 'code',
        scope: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/gmail.compose',
          'https://www.googleapis.com/auth/calendar.readonly',
          'https://www.googleapis.com/auth/calendar.events',
        ].join(' '),
        access_type: 'offline',
        prompt:      'consent',
      });
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
      return reply.code(200).send({ success: true, data: { authUrl } });
    }
  );

  // GET /api/gmail/callback — OAuth token exchange
  fastify.get(
    '/gmail/callback',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { code } = request.query as { code?: string };
      if (!code) {
        return reply.code(400).send({ success: false, error: 'Missing OAuth code' });
      }
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          code,
          client_id:     process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri:  process.env.GOOGLE_REDIRECT_URI!,
          grant_type:    'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json() as GoogleTokenExchangeResponse;
      await prisma.googleToken.upsert({
        where:  { userId: request.user!.id },
        create: {
          userId:       request.user!.id,
          accessToken:  tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt:    new Date(Date.now() + tokenData.expires_in * 1000),
        },
        update: {
          accessToken:  tokenData.access_token,
          refreshToken: tokenData.refresh_token ?? undefined,
          expiresAt:    new Date(Date.now() + tokenData.expires_in * 1000),
        },
      });
      return reply.redirect(`${process.env.FRONTEND_URL ?? 'https://airflow-dashboard.vercel.app'}/pdl-office?connected=true`);
    }
  );

  // GET /api/gmail/messages — fetch and cache inbox
  fastify.get(
    '/gmail/messages',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const accessToken = await getGmailToken(request.user!.id);

      const listRes  = await fetch(`${GMAIL_BASE}/messages?maxResults=20`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const listData = await listRes.json() as GmailListResponse;
      const refs     = listData.messages ?? [];

      const messages = await Promise.all(
        refs.map(async (ref) => {
          const msgRes  = await fetch(`${GMAIL_BASE}/messages/${ref.id}?format=metadata`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const msg = await msgRes.json() as GmailMessage;
          const headers = msg.payload?.headers;
          const from     = getHeader(headers, 'From');
          const to       = getHeader(headers, 'To');
          const subject  = getHeader(headers, 'Subject');
          const receivedAt = msg.internalDate
            ? new Date(Number(msg.internalDate))
            : new Date();

          // Cache to EmailLog (upsert — no-op if already stored)
          await prisma.emailLog.upsert({
            where:  { gmailId: msg.id },
            create: { gmailId: msg.id, from, to, subject, snippet: msg.snippet, receivedAt },
            update: {},
          });

          return { id: msg.id, from, to, subject, snippet: msg.snippet, receivedAt };
        })
      );

      return reply.code(200).send({ success: true, messages });
    }
  );

  // POST /api/gmail/send
  fastify.post(
    '/gmail/send',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SendSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const accessToken = await getGmailToken(request.user!.id);
      const raw = buildMimeMessage(parsed.data.to, parsed.data.subject, parsed.data.body);
      await fetch(`${GMAIL_BASE}/messages/send`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ raw }),
      });
      return reply.code(200).send({ success: true });
    }
  );

  // POST /api/gmail/draft
  fastify.post(
    '/gmail/draft',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = DraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const accessToken = await getGmailToken(request.user!.id);
      const raw = buildMimeMessage(parsed.data.to, parsed.data.subject, parsed.data.body);
      const res  = await fetch(`${GMAIL_BASE}/drafts`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: { raw } }),
      });
      const data = await res.json() as { id: string };
      return reply.code(200).send({ success: true, data: { draftId: data.id } });
    }
  );

  // GET /api/gmail/search
  fastify.get(
    '/gmail/search',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { q } = request.query as { q?: string };
      if (!q) return reply.code(400).send({ success: false, error: 'Query param q is required' });

      const accessToken = await getGmailToken(request.user!.id);
      const listRes  = await fetch(`${GMAIL_BASE}/messages?q=${encodeURIComponent(q)}&maxResults=20`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const listData = await listRes.json() as GmailListResponse;
      const refs     = listData.messages ?? [];

      const messages = await Promise.all(
        refs.map(async (ref) => {
          const msgRes = await fetch(`${GMAIL_BASE}/messages/${ref.id}?format=metadata`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const msg     = await msgRes.json() as GmailMessage;
          const headers = msg.payload?.headers;
          return {
            id:          msg.id,
            from:        getHeader(headers, 'From'),
            to:          getHeader(headers, 'To'),
            subject:     getHeader(headers, 'Subject'),
            snippet:     msg.snippet,
            receivedAt:  msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(),
          };
        })
      );

      return reply.code(200).send({ success: true, messages });
    }
  );
}
