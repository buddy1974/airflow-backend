import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyEnv from '@fastify/env';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';

import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { staffRoutes } from './routes/staff';
import { taskRoutes } from './routes/tasks';
import { locationRoutes } from './routes/locations';
import { contactRoutes } from './routes/contact';
import { escalationRoutes } from './routes/escalations';
import { seedLocation } from './scripts/seedLocation';

import { FastifyRequest } from 'fastify';

const envSchema = {
  type: 'object',
  required: ['DATABASE_URL', 'JWT_SECRET'],
  properties: {
    DATABASE_URL: { type: 'string' },
    JWT_SECRET:   { type: 'string' },
    PORT:         { type: 'string', default: '3000' },
    HOST:         { type: 'string', default: '0.0.0.0' },
  },
};

declare module 'fastify' {
  interface FastifyInstance {
    config: {
      DATABASE_URL: string;
      JWT_SECRET: string;
      PORT: string;
      HOST: string;
    };
  }
}

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      },
    },
  });

  fastify.register(fastifyEnv, { schema: envSchema, dotenv: true });
  fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  fastify.register(cors, {
    origin: [
      process.env.FRONTEND_URL ?? 'https://airflow-dashboard.vercel.app',
      process.env.WEBSITE_URL  ?? 'https://airflow.maxpromo.digital',
      'http://localhost:3001',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  await fastify.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request: FastifyRequest, context: { after: string }) => ({
      success: false,
      error: `Rate limit exceeded. Try again in ${context.after}`,
    }),
  });

  fastify.register(healthRoutes);
  fastify.register(authRoutes);
  fastify.register(userRoutes);
  fastify.register(staffRoutes);
  fastify.register(taskRoutes);
  fastify.register(locationRoutes);
  fastify.register(contactRoutes);
  fastify.register(escalationRoutes);

  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    reply.status(500).send({ success: false, error: 'Internal Server Error' });
  });

  return fastify;
}

async function start() {
  const fastify = await buildServer();
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log('AIRFLOW BACKEND RUNNING ON PORT:', PORT);
    await seedLocation();
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error(`PORT ${PORT} already in use`);
      process.exit(1);
    }
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
