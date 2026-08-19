/**
 * fraud-shadow — the ONLY oracle agent that calls the Anthropic LLM.
 * Hard budget: ≤800 input tokens, max_tokens=200 output.
 * All other agents are rule-based only.
 * On any LLM or parse failure, returns a safe zero-risk fallback vote.
 */

import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { limitedCreate } from '../../lib/claudeLimiter.js';
import type Database from 'better-sqlite3';
import type { OracleVote } from '@bunqsy/shared';
import {
  getRecentTransactions,
  getDailySpend,
  getAverageDailySpend,
} from '../../memory/transactions.js';
import type { RecallSnapshot } from '../../heartbeat/recall.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FALLBACK_VOTE: OracleVote = {
  agentId:         'fraud-shadow',
  riskScore:       0,
  rationale:       'Fraud analysis unavailable',
  shouldIntervene: false,
};

// ─── Zod schema for LLM output ────────────────────────────────────────────────

const FraudVoteSchema = z.object({
  riskScore:       z.number().min(0).max(100),
  rationale:       z.string().max(200),
  shouldIntervene: z.boolean(),
  suggestedType:   z.string().nullable().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractJsonText(raw: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  return match?.[1]?.trim() ?? raw.trim();
}

function buildUserPrompt(
  snapshot: RecallSnapshot,
  daily: number,
  avgDaily: number,
  txLines: string[],
): string {
  return [
    `Recent transactions (account ${snapshot.primaryAccountId}):`,
    ...txLines,
    '',
    `Daily spend: €${daily.toFixed(2)} | 30d avg: €${avgDaily.toFixed(2)} | Balance: €${(snapshot.balanceCents / 100).toFixed(2)}`,
    '',
    'Return ONLY valid JSON (no markdown):',
    '{"riskScore":0-100,"rationale":"<120 chars","shouldIntervene":true/false,"suggestedType":"FREEZE_CARD|ALERT|null"}',
  ].join('\n');
}

// ─── Agent entry point ────────────────────────────────────────────────────────

export async function run(
  snapshot: RecallSnapshot,
  db: Database.Database,
): Promise<OracleVote> {
  try {
    const txs     = getRecentTransactions(db, 5, snapshot.primaryAccountId);
    const daily   = getDailySpend(db, snapshot.primaryAccountId);
    const avgDaily = getAverageDailySpend(db, snapshot.primaryAccountId, 30);

    const txLines = txs.map((tx) => {
      const sign = tx.amount > 0 ? '+' : '';
      const desc = tx.description?.slice(0, 30) ?? '';
      return `  ${tx.created_at.slice(0, 10)} ${sign}€${tx.amount.toFixed(2)} "${tx.counterparty_name ?? 'unknown'}" ${desc}`.trimEnd();
    });

    const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

    const response = await limitedCreate(anthropic, {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system:     'You are a financial fraud detection system. Respond ONLY with a single JSON object and nothing else.',
      messages:   [{ role: 'user', content: buildUserPrompt(snapshot, daily, avgDaily, txLines) }],
    });

    const block = response.content[0];
    if (!block || block.type !== 'text') {
      throw new Error('LLM returned no text content');
    }

    const rawJson: unknown = JSON.parse(extractJsonText(block.text));
    const parsed = FraudVoteSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new Error(`LLM output failed validation: ${parsed.error.message}`);
    }

    const { riskScore, rationale, shouldIntervene, suggestedType } = parsed.data;
    return { agentId: 'fraud-shadow', riskScore, rationale, shouldIntervene, suggestedType: suggestedType ?? undefined };
  } catch (err: unknown) {
    console.error('[fraud-shadow]', err instanceof Error ? err.message : String(err));
    return FALLBACK_VOTE;
  }
}
