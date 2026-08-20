import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../memory/db.js';
import { getReviewQueue, approveReviewItem, bulkApproveQueue, getPendingReviewCount } from '../bookkeeping/review-queue.js';
import { generateProfitAndLoss, generateTaxSummary } from '../bookkeeping/reports.js';
import { getAllVatPeriods, markVatPeriodFiled } from '../bookkeeping/vat-tracker.js';
import { exportToCSV, exportToMT940 } from '../bookkeeping/exporter.js';
import { getUncategorizedCount } from '../bookkeeping/ledger.js';
import type { TaxCategory } from '@bunqsy/shared';
import { TaxCategorySchema } from '@bunqsy/shared';
import { wsEmit } from './ws.js';
import { IdParam, IsoDate, QuarterParam, YearParam, parseOr400, safeFilenamePart } from '../security/validate.js';

/** Shared date-window parser for the report + export endpoints. */
function dateWindow(query: { start?: string; end?: string }): { start: string; end: string } {
  const now = new Date();
  const start = parseOr400(IsoDate, query.start ?? `${now.getFullYear()}-01-01`, 'start');
  const end   = parseOr400(IsoDate, query.end   ?? now.toISOString().slice(0, 10), 'end');
  if (start > end) throw new (class extends Error { statusCode = 400; })('start must be before end');
  return { start, end };
}

export async function registerBookkeepingRoutes(
  fastify: FastifyInstance,
  getIBAN: () => string,
): Promise<void> {
  const db = getDb();

  // ── GET /api/bookkeeping/review-queue ────────────────────────────────────────
  fastify.get('/api/bookkeeping/review-queue', async (_req: FastifyRequest, reply: FastifyReply) => {
    const queue = getReviewQueue(db);
    return reply.send({ items: queue, total: queue.length });
  });

  // ── POST /api/bookkeeping/review-queue/:entryId/approve ─────────────────────
  fastify.post(
    '/api/bookkeeping/review-queue/:entryId/approve',
    async (req: FastifyRequest<{ Params: { entryId: string }; Body: { categoryOverride?: string } }>, reply: FastifyReply) => {
      const entryId = parseOr400(IdParam, req.params.entryId, 'entryId');
      const body        = req.body as { categoryOverride?: string } | undefined;
      let override: TaxCategory | undefined;

      if (body?.categoryOverride) {
        const parsed = TaxCategorySchema.safeParse(body.categoryOverride);
        if (!parsed.success) {
          return reply.status(400).send({ error: 'Invalid category' });
        }
        override = parsed.data;
      }

      const ok = approveReviewItem(db, entryId, override);
      if (!ok) return reply.status(404).send({ error: 'Entry not found' });

      // Push updated count
      wsEmit({ type: 'review_queue_update', payload: { pendingCount: getPendingReviewCount(db) } } as Parameters<typeof wsEmit>[0]);

      return reply.send({ success: true });
    },
  );

  // ── POST /api/bookkeeping/review-queue/bulk-approve ─────────────────────────
  fastify.post('/api/bookkeeping/review-queue/bulk-approve', async (_req: FastifyRequest, reply: FastifyReply) => {
    const count = bulkApproveQueue(db);
    wsEmit({ type: 'review_queue_update', payload: { pendingCount: 0 } } as Parameters<typeof wsEmit>[0]);
    return reply.send({ approved: count });
  });

  // ── GET /api/bookkeeping/pl ───────────────────────────────────────────────────
  fastify.get(
    '/api/bookkeeping/pl',
    async (req: FastifyRequest<{ Querystring: { start?: string; end?: string } }>, reply: FastifyReply) => {
      const { start, end } = dateWindow(req.query);
      const pl = generateProfitAndLoss(db, start, end);
      return reply.send(pl);
    },
  );

  // ── GET /api/bookkeeping/tax-summary ─────────────────────────────────────────
  fastify.get(
    '/api/bookkeeping/tax-summary',
    async (req: FastifyRequest<{ Querystring: { year?: string } }>, reply: FastifyReply) => {
      const year = parseOr400(YearParam, req.query.year ?? new Date().getFullYear(), 'year');
      const summary = generateTaxSummary(db, year);
      return reply.send(summary);
    },
  );

  // ── GET /api/bookkeeping/vat ──────────────────────────────────────────────────
  fastify.get('/api/bookkeeping/vat', async (_req: FastifyRequest, reply: FastifyReply) => {
    const periods = getAllVatPeriods(db);
    return reply.send({ periods });
  });

  // ── POST /api/bookkeeping/vat/:quarter/file ───────────────────────────────────
  fastify.post(
    '/api/bookkeeping/vat/:quarter/file',
    async (req: FastifyRequest<{ Params: { quarter: string }; Body: { year?: number } }>, reply: FastifyReply) => {
      const quarter = parseOr400(QuarterParam, req.params.quarter, 'quarter');
      const year    = parseOr400(YearParam, (req.body as { year?: number } | undefined)?.year ?? new Date().getFullYear(), 'year');
      const ok = markVatPeriodFiled(db, year, quarter);
      if (!ok) return reply.status(404).send({ error: 'Period not found or already filed' });
      return reply.send({ success: true });
    },
  );

  // ── GET /api/bookkeeping/export/csv ──────────────────────────────────────────
  fastify.get(
    '/api/bookkeeping/export/csv',
    async (req: FastifyRequest<{ Querystring: { start?: string; end?: string } }>, reply: FastifyReply) => {
      const { start, end } = dateWindow(req.query);
      const csv = exportToCSV(db, start, end);
      // Filename parts are request-controlled: strip anything that could close
      // the quoted string or inject a second header line.
      const name = `bunqsy-export-${safeFilenamePart(start)}-${safeFilenamePart(end)}.csv`;
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .send(csv);
    },
  );

  // ── GET /api/bookkeeping/export/mt940 ─────────────────────────────────────────
  fastify.get(
    '/api/bookkeeping/export/mt940',
    async (req: FastifyRequest<{ Querystring: { start?: string; end?: string } }>, reply: FastifyReply) => {
      const { start, end } = dateWindow(req.query);
      const iban  = getIBAN();
      const mt940 = exportToMT940(db, start, end, iban);
      const name = `bunqsy-export-${safeFilenamePart(start)}-${safeFilenamePart(end)}.mt940`;
      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .send(mt940);
    },
  );

  // ── GET /api/bookkeeping/status ───────────────────────────────────────────────
  fastify.get('/api/bookkeeping/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const uncategorized  = getUncategorizedCount(db);
    const pendingReview  = getPendingReviewCount(db);
    const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM transactions`).get() as { cnt: number };
    const journalRow = db.prepare(`SELECT COUNT(*) as cnt FROM journal_entries`).get() as { cnt: number };

    return reply.send({
      totalTransactions: totalRow.cnt,
      journalEntries:    journalRow.cnt,
      uncategorized,
      pendingReview,
    });
  });
}
