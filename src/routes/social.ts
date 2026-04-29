import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SocialPostStatus } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import { getOpenAI } from '../lib/openai';
import prisma from '../db/prisma';

function fireSocialWebhook(payload: Record<string, unknown>): void {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch((err) => console.error('[social] n8n webhook failed:', err));
}

const DraftSchema = z.object({
  thema: z.string().min(1),
  ton:   z.string().optional(),
});

const UpdatePostSchema = z.object({
  inhalt:     z.string().min(1).optional(),
  titel:      z.string().min(1).optional(),
  geplantFuer: z.string().datetime().nullable().optional(),
  bildUrl:    z.string().nullable().optional(),
});

export async function socialRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/social/draft
  fastify.post(
    '/social/draft',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = DraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { thema, ton = 'professionell und fürsorglich' } = parsed.data;

      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'Du bist ein Social Media Manager für airflow Fachpflegedienst in Krefeld. Erstelle ansprechende Facebook-Posts auf Deutsch. Ton: professionell, einfühlsam, informativ. Maximal 280 Zeichen. Füge passende Emojis hinzu. Maximal 3 relevante Hashtags.',
          },
          {
            role: 'user',
            content: `Thema: ${thema}\nTon: ${ton}`,
          },
        ],
        max_tokens: 200,
      });

      const inhalt = response.choices[0].message.content?.trim() ?? '';

      const post = await prisma.socialPost.create({
        data: {
          titel:      thema,
          inhalt,
          status:     SocialPostStatus.ENTWURF,
          createdById: request.user!.id,
        },
      });

      return reply.code(201).send({ success: true, data: post });
    }
  );

  // GET /api/social/posts
  fastify.get(
    '/social/posts',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const posts = await prisma.socialPost.findMany({
        orderBy: { createdAt: 'desc' },
      });
      return reply.code(200).send({ success: true, data: posts });
    }
  );

  // PUT /api/social/posts/:id
  fastify.put<{ Params: { id: string } }>(
    '/social/posts/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdatePostSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const { geplantFuer, ...rest } = parsed.data;
        const post = await prisma.socialPost.update({
          where: { id: request.params.id },
          data:  {
            ...rest,
            ...(geplantFuer !== undefined && {
              geplantFuer: geplantFuer ? new Date(geplantFuer) : null,
            }),
          },
        });
        return reply.code(200).send({ success: true, data: post });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Post not found' });
        }
        throw err;
      }
    }
  );

  // POST /api/social/posts/:id/publish
  fastify.post<{ Params: { id: string } }>(
    '/social/posts/:id/publish',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const existing = await prisma.socialPost.findUnique({ where: { id: request.params.id } });
        if (!existing) return reply.code(404).send({ success: false, error: 'Post not found' });

        const newStatus = existing.geplantFuer
          ? SocialPostStatus.GEPLANT
          : SocialPostStatus.VEROEFFENTLICHT;

        const post = await prisma.socialPost.update({
          where: { id: request.params.id },
          data:  {
            status:           newStatus,
            veroeffentlichtAm: newStatus === SocialPostStatus.VEROEFFENTLICHT ? new Date() : undefined,
          },
        });

        fireSocialWebhook({
          type:       'SOCIAL_PUBLISH',
          postId:     post.id,
          inhalt:     post.inhalt,
          plattform:  post.plattform,
          geplantFuer: post.geplantFuer,
        });

        return reply.code(200).send({ success: true, data: post });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Post not found' });
        }
        throw err;
      }
    }
  );

  // DELETE /api/social/posts/:id
  fastify.delete<{ Params: { id: string } }>(
    '/social/posts/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await prisma.socialPost.delete({ where: { id: request.params.id } });
        return reply.code(200).send({ success: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Post not found' });
        }
        throw err;
      }
    }
  );
}
