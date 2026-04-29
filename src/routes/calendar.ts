import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import { getGmailToken } from '../lib/googleAuth';
import { getOpenAI, hasOpenAI } from '../lib/openai';

// ─── Google Calendar API types ────────────────────────────────────────────────

interface CalendarDateTime { dateTime?: string; date?: string; }
interface CalendarAttendee { email: string; displayName?: string; }

interface CalendarEvent {
  id?:          string;
  summary?:     string;
  description?: string;
  start?:       CalendarDateTime;
  end?:         CalendarDateTime;
  attendees?:   CalendarAttendee[];
}

interface CalendarEventsResponse { items?: CalendarEvent[]; }

// ─── Helper ───────────────────────────────────────────────────────────────────

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

async function fetchCalendarEvents(accessToken: string, timeMin: Date, timeMax: Date, maxResults = 20): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin:      timeMin.toISOString(),
    timeMax:      timeMax.toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   String(maxResults),
  });
  const res  = await fetch(`${CAL_BASE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json() as CalendarEventsResponse;
  return data.items ?? [];
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function calendarRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/calendar/today
  fastify.get(
    '/calendar/today',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const accessToken = await getGmailToken(request.user!.id);
      const now         = new Date();
      const startOfDay  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const endOfDay    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
      const events      = await fetchCalendarEvents(accessToken, startOfDay, endOfDay);
      return reply.code(200).send({ success: true, events });
    }
  );

  // GET /api/calendar/upcoming — next 7 days
  fastify.get(
    '/calendar/upcoming',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const accessToken = await getGmailToken(request.user!.id);
      const now         = new Date();
      const in7Days     = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const events      = await fetchCalendarEvents(accessToken, now, in7Days);
      return reply.code(200).send({ success: true, events });
    }
  );

  // GET /api/calendar/prep — AI-powered meeting prep for today
  fastify.get(
    '/calendar/prep',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const accessToken = await getGmailToken(request.user!.id);
      const now         = new Date();
      const startOfDay  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const endOfDay    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
      const events      = await fetchCalendarEvents(accessToken, startOfDay, endOfDay);

      if (!hasOpenAI()) {
        return reply.code(200).send({ success: true, events: events.map(e => ({ ...e, prepNote: null })) });
      }

      const eventsWithPrep = await Promise.all(
        events.map(async (event) => {
          if (!event.summary) return { ...event, prepNote: null };
          try {
            const attendeeList = (event.attendees ?? []).map(a => a.displayName ?? a.email).join(', ') || 'keine';
            const completion = await getOpenAI().chat.completions.create({
              model:      'gpt-4o',
              max_tokens: 200,
              messages: [
                {
                  role:    'system',
                  content: 'Du bist ein Assistent für die Pflegedienstleiterin von airflow Fachpflegedienst. Erstelle kurze Vorbereitungsnotizen auf Deutsch.',
                },
                {
                  role:    'user',
                  content: `Termin: ${event.summary}\nBeschreibung: ${event.description ?? 'keine'}\nTeilnehmer: ${attendeeList}\n\nErstelle maximal 3 Stichpunkte zur Vorbereitung.`,
                },
              ],
            });
            return { ...event, prepNote: completion.choices[0]?.message?.content ?? null };
          } catch {
            return { ...event, prepNote: null };
          }
        })
      );

      return reply.code(200).send({ success: true, events: eventsWithPrep });
    }
  );
}
