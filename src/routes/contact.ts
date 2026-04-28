import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sendEmail } from '../services/emailService';

const ContactSchema = z.object({
  name:    z.string().min(1),
  email:   z.string().email(),
  subject: z.string().min(1),
  message: z.string().min(1),
});

export async function contactRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/contact',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ContactSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { name, email, subject, message } = parsed.data;

      const result = await sendEmail({
        to:      'air.flow@gmx.de',
        subject: `Kontaktanfrage: ${subject}`,
        body:    `Von: ${name} <${email}>\n\n${message}`,
      });

      if (!result.success) {
        return reply.code(500).send({ success: false, error: 'Failed to send message' });
      }

      return reply.code(200).send({ success: true, message: 'Message sent' });
    }
  );
}
