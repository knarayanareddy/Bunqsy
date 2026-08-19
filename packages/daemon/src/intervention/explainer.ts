/**
 * CONSTITUTIONAL RULE: EXPLAINABILITY IS NOT OPTIONAL.
 * Every intervention card must have a plain-English narration generated here.
 * On any LLM failure the fallback text still satisfies the rule — the user
 * always sees a human-readable explanation, never raw JSON.
 */

import Anthropic from '@anthropic-ai/sdk';
import { limitedCreate } from '../lib/claudeLimiter.js';
import type { OracleVerdict } from '@bunqsy/shared';
import type { HandlerResult } from './types.js';
import type { RecallSnapshot } from '../heartbeat/recall.js';

function buildPrompt(
  verdict:  OracleVerdict,
  result:   HandlerResult,
  snapshot: RecallSnapshot,
): string {
  const balance    = (snapshot.balanceCents / 100).toFixed(2);
  const actionNote = result.planId
    ? 'A financial action has been prepared and awaits your approval.'
    : '';

  return [
    'You are BUNQSY, a calm and supportive financial guardian. Write a concise 2–3 sentence message alerting the user to a financial situation.',
    '',
    'Situation:',
    `  Risk score:  ${verdict.aggregateRiskScore}/100`,
    `  Issue type:  ${result.type.replace(/_/g, ' ')}`,
    `  Balance:     €${balance}`,
    `  Analysis:    ${verdict.rationale.slice(0, 300)}`,
    actionNote ? `  Action:      ${actionNote}` : '',
    '',
    'Rules:',
    '- Address the user directly ("your", "you").',
    '- Be specific with amounts where available.',
    '- Tone: calm and caring, never alarmist.',
    '- No markdown, no bullet points, no JSON. Plain sentences only.',
  ].filter(Boolean).join('\n');
}

export async function generateNarration(
  verdict:  OracleVerdict,
  result:   HandlerResult,
  snapshot: RecallSnapshot,
): Promise<string> {
  try {
    const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

    const response = await limitedCreate(anthropic, {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages:   [{ role: 'user', content: buildPrompt(verdict, result, snapshot) }],
    });

    const block = response.content[0];
    if (!block || block.type !== 'text') throw new Error('No text block in narration response');

    const text = block.text.trim();
    if (!text) throw new Error('Empty narration returned');

    return text;
  } catch (err: unknown) {
    // Fallback — constitutional rule requires narration to always exist
    const label = result.type.replace(/_/g, ' ').toLowerCase();
    return `BUNQSY has detected a ${label} situation (risk level ${verdict.aggregateRiskScore}/100). Please review your account activity.`;
  }
}
