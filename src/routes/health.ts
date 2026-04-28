import { FastifyInstance } from 'fastify';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async (_request, reply) => {
    return reply.code(200).send({ status: 'ok', project: 'airflow-backend', phase: 1 });
  });
}
