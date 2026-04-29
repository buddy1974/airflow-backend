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
import { patientRoutes } from './routes/patients';
import { carePlanRoutes } from './routes/carePlans';
import { incidentRoutes } from './routes/incidents';
import { medicationRoutes } from './routes/medications';
import { monitoringRoutes } from './routes/monitoring';
import { deviceRoutes } from './routes/devices';
import { handoverRoutes } from './routes/handover';
import { financeRoutes } from './routes/finance';
import { rotaRoutes } from './routes/rotas';
import { trainingRoutes } from './routes/training';
import { recruitmentRoutes } from './routes/recruitment';
import { complianceRoutes } from './routes/compliance';
import { staffDocumentRoutes } from './routes/staffDocuments';
import { hrRoutes } from './routes/hr';
import { seedLocation } from './scripts/seedLocation';
import { seedPatients } from './scripts/seedPatients';
import { seedDevices } from './scripts/seedDevices';

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
  fastify.register(patientRoutes,    { prefix: '/api' });
  fastify.register(carePlanRoutes,   { prefix: '/api' });
  fastify.register(incidentRoutes,   { prefix: '/api' });
  fastify.register(medicationRoutes,  { prefix: '/api' });
  fastify.register(monitoringRoutes,  { prefix: '/api' });
  fastify.register(deviceRoutes,      { prefix: '/api' });
  fastify.register(handoverRoutes,    { prefix: '/api' });
  fastify.register(financeRoutes,     { prefix: '/api' });
  fastify.register(rotaRoutes,          { prefix: '/api' });
  fastify.register(trainingRoutes,      { prefix: '/api' });
  fastify.register(recruitmentRoutes,   { prefix: '/api' });
  fastify.register(complianceRoutes,    { prefix: '/api' });
  fastify.register(staffDocumentRoutes, { prefix: '/api' });
  fastify.register(hrRoutes,            { prefix: '/api' });

  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    reply.status(500).send({ success: false, error: 'Internal Server Error' });
  });

  return fastify;
}

async function start() {
  const fastify = await buildServer();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';

  try {
    await fastify.listen({ port, host });
    console.log('AIRFLOW BACKEND RUNNING ON PORT:', port);
    await seedLocation();
    await seedPatients();
    await seedDevices();
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error(`PORT ${port} already in use`);
      process.exit(1);
    }
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
