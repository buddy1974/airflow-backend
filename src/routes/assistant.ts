import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import { getOpenAI, hasOpenAI } from '../lib/openai';

const AskSchema = z.object({
  message: z.string().min(1),
  conversationHistory: z.array(
    z.object({
      role:    z.enum(['user', 'assistant']),
      content: z.string(),
    })
  ).optional(),
});

const DONNA_SYSTEM_PROMPT =
  'Du bist Donna, die KI-Assistentin von airflow Fachpflegedienst in Krefeld. ' +
  'Du unterstützt das Pflegeteam bei der täglichen Arbeit in der ambulanten Beatmungspflege. ' +
  'Du sprichst Deutsch. Du bist präzise, fürsorglich und professionell. ' +
  'Du hilfst bei: Pflegedokumentation, MDK-Vorbereitung, Schichtplanung, Gerätefragen, Patientenzusammenfassungen. ' +
  'Halte Antworten prägnant und umsetzbar.';

export async function assistantRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/assistant/ask
  fastify.post(
    '/assistant/ask',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!hasOpenAI()) {
        return reply.code(503).send({ success: false, error: 'AI assistant not available' });
      }

      const parsed = AskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const history = (parsed.data.conversationHistory ?? []).slice(-10);

      const completion = await getOpenAI().chat.completions.create({
        model:      'gpt-4o',
        max_tokens: 1500,
        messages: [
          { role: 'system', content: DONNA_SYSTEM_PROMPT },
          ...history.map(m => ({
            role:    m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user', content: parsed.data.message },
        ],
      });

      const response = completion.choices[0]?.message?.content ?? '';
      return reply.code(200).send({ success: true, data: { response } });
    }
  );
}
