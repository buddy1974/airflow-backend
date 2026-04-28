import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TaskStatus, TaskPriority } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateTaskSchema = z.object({
  title:       z.string().min(1),
  description: z.string().optional(),
  priority:    z.nativeEnum(TaskPriority).default('MEDIUM'),
  dueDate:     z.string().datetime().optional(),
  locationId:  z.string().optional(),
});

const UpdateTaskSchema = z.object({
  title:       z.string().min(1).optional(),
  description: z.string().optional(),
  status:      z.nativeEnum(TaskStatus).optional(),
  priority:    z.nativeEnum(TaskPriority).optional(),
  dueDate:     z.string().datetime().nullable().optional(),
  locationId:  z.string().nullable().optional(),
});

const AssignSchema = z.object({
  userId: z.string().min(1),
});

const taskInclude = {
  location: { select: { id: true, name: true } },
  assignments: { include: { user: { select: { id: true, name: true, email: true } } } },
};

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/tasks
  fastify.get(
    '/api/tasks',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, priority, locationId } = request.query as {
        status?: string;
        priority?: string;
        locationId?: string;
      };

      const where: Record<string, unknown> = {};
      if (status)     where.status = status;
      if (priority)   where.priority = priority;
      if (locationId) where.locationId = locationId;

      // Pflegekraft only sees tasks assigned to them
      if (request.user?.role === 'PFLEGEKRAFT') {
        where.assignments = { some: { userId: request.user.id } };
      }

      const tasks = await prisma.task.findMany({
        where,
        include: taskInclude,
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      });
      return reply.code(200).send({ success: true, tasks });
    }
  );

  // GET /api/tasks/summary
  fastify.get(
    '/api/tasks/summary',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [total, pending, inProgress, completed, urgent] = await Promise.all([
        prisma.task.count(),
        prisma.task.count({ where: { status: 'PENDING' } }),
        prisma.task.count({ where: { status: 'IN_PROGRESS' } }),
        prisma.task.count({ where: { status: 'COMPLETED' } }),
        prisma.task.count({ where: { priority: 'URGENT' } }),
      ]);
      return reply.code(200).send({ success: true, summary: { total, pending, inProgress, completed, urgent } });
    }
  );

  // GET /api/tasks/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/tasks/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const task = await prisma.task.findUnique({
        where: { id: request.params.id },
        include: taskInclude,
      });
      if (!task) return reply.code(404).send({ success: false, error: 'Task not found' });
      return reply.code(200).send({ success: true, task });
    }
  );

  // POST /api/tasks
  fastify.post(
    '/api/tasks',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const task = await prisma.task.create({
        data: {
          title:       parsed.data.title,
          description: parsed.data.description,
          priority:    parsed.data.priority,
          dueDate:     parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
          locationId:  parsed.data.locationId,
          createdById: request.user!.id,
        },
        include: taskInclude,
      });
      return reply.code(201).send({ success: true, task });
    }
  );

  // PUT /api/tasks/:id
  fastify.put<{ Params: { id: string } }>(
    '/api/tasks/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const task = await prisma.task.update({
        where: { id: request.params.id },
        data: {
          ...parsed.data,
          dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : parsed.data.dueDate,
        },
        include: taskInclude,
      });
      return reply.code(200).send({ success: true, task });
    }
  );

  // DELETE /api/tasks/:id — ADMIN only
  fastify.delete<{ Params: { id: string } }>(
    '/api/tasks/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      await prisma.task.delete({ where: { id: request.params.id } });
      return reply.code(200).send({ success: true });
    }
  );

  // POST /api/tasks/:id/assign
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/assign',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = AssignSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const assignment = await prisma.taskAssignment.create({
          data: { taskId: request.params.id, userId: parsed.data.userId },
          include: { user: { select: { id: true, name: true, email: true } } },
        });
        return reply.code(201).send({ success: true, assignment });
      } catch (err: any) {
        if (err.code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'User already assigned to this task' });
        }
        if (err.code === 'P2025') {
          return reply.code(404).send({ success: false, error: 'Task or user not found' });
        }
        throw err;
      }
    }
  );
}
