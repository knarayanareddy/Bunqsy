import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { limitedCreate } from '../lib/claudeLimiter.js';
import type { ExecutionStep } from '@bunqsy/shared';

const PLANNER_SYSTEM = `
You are BUNQSY, an always-on financial guardian for a bunq user.
The user has just spoken a financial instruction. Your job is to:
1. Understand the intent
2. Create a precise ExecutionPlan with specific steps
3. Write a clear narratedText in first person (e.g. "I will send €20 to Sarah...")
4. Return ONLY valid JSON matching the ExecutionPlan schema
5. Never execute — only plan. Execution requires user confirmation.

Available step types: PAYMENT, DRAFT_PAYMENT, SAVINGS_TRANSFER, CANCEL_DRAFT

Step payload shapes:
- PAYMENT: { fromAccountId, amount, currency, toIban, toName, description }
- DRAFT_PAYMENT: { entry: { amount: { value, currency }, counterparty_alias, description } }
- SAVINGS_TRANSFER: { fromAccountId, toAccountId, amount, currency, description }
- CANCEL_DRAFT: { draftPaymentId }

Current account balance: {balance}
Available accounts: {accounts}

Respond ONLY with a JSON object of this exact shape — no markdown, no explanation:
{
  "narratedText": "I will...",
  "steps": [
    {
      "id": "<uuid>",
      "type": "PAYMENT",
      "description": "...",
      "payload": { ... }
    }
  ]
}

If the instruction is unclear or cannot be safely planned, respond with:
{
  "narratedText": "I couldn't understand that instruction clearly. Please try again.",
  "steps": []
}
`.trim();

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ExecutionStepSchema = z.object({
  id: z.string(),
  type: z.enum(['PAYMENT', 'DRAFT_PAYMENT', 'SAVINGS_TRANSFER', 'CANCEL_DRAFT']),
  description: z.string(),
  payload: z.record(z.unknown()),
});

const PlannerOutputSchema = z.object({
  narratedText: z.string().min(1),
  steps: z.array(ExecutionStepSchema),
});

export interface PlannerContext {
  balanceEur: number;
  accounts: Array<{ id: number; description: string; balanceEur: number }>;
}

export interface PlannerOutput {
  narratedText: string;
  steps: ExecutionStep[];
}

const FALLBACK_OUTPUT: PlannerOutput = {
  narratedText: "I couldn't understand that instruction. Please speak clearly and try again.",
  steps: [],
};

export async function planFromTranscript(
  transcript: string,
  context: PlannerContext,
): Promise<PlannerOutput> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey });

  const accountsText = context.accounts.length > 0
    ? context.accounts.map(a => `  - Account ${a.id} (${a.description}): €${a.balanceEur.toFixed(2)}`).join('\n')
    : '  - Primary account: €' + context.balanceEur.toFixed(2);

  const systemPrompt = PLANNER_SYSTEM
    .replace('{balance}', `€${context.balanceEur.toFixed(2)}`)
    .replace('{accounts}', '\n' + accountsText);

  let rawText: string;
  try {
    const msg = await limitedCreate(client, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `User said: "${transcript}"` },
      ],
    });

    const block = msg.content[0];
    rawText = block?.type === 'text' ? block.text.trim() : '';
  } catch (err) {
    console.error('[planner] Anthropic call failed:', err instanceof Error ? err.message : String(err));
    return FALLBACK_OUTPUT;
  }

  // Strip any markdown code fences Claude might add despite instructions
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.error('[planner] JSON parse failed:', jsonText.slice(0, 200));
    return FALLBACK_OUTPUT;
  }

  const result = PlannerOutputSchema.safeParse(parsed);
  if (!result.success) {
    console.error('[planner] Schema validation failed:', result.error.message);
    return FALLBACK_OUTPUT;
  }

  // Ensure every step has a valid UUID id (Claude might omit or duplicate)
  const steps: ExecutionStep[] = result.data.steps.map(s => ({
    ...s,
    id: s.id && s.id.length > 0 ? s.id : uuid(),
  }));

  return { narratedText: result.data.narratedText, steps };
}
