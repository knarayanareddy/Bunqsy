import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../memory/db.js';
import { transcribeAudio } from '../voice/stt.js';
import { textToSpeech } from '../voice/tts.js';
import { planFromTranscript } from '../voice/planner.js';
import { classifyIntent } from '../voice/intent.js';
import {
  handleTriggerDream,
  handleSimulateFraud,
  handleSimulateSalary,
  handleFundSandbox,
  handleReadScore,
  handleReadInterventions,
  handleReadForecast,
  handleReadDreamReport,
} from '../voice/actions.js';
import { createExecutionPlan, confirmPlan, executePlan, cancelPlan } from '../bunq/execute.js';
import { resolveIntervention } from '../memory/interventions.js';
import { wsEmit } from './ws.js';
import type { ScoreLogRow, UserProfileRow } from '@bunqsy/shared';
import { IdParam, SpeakBody, UuidParam, parseOr400 } from '../security/validate.js';

/**
 * Spoken instructions are the most sensitive text this system handles — they
 * contain names, amounts and IBANs. They are never written to the log unless an
 * operator explicitly opts in for debugging.
 */
function redactTranscript(transcript: string): string {
  if (process.env['LOG_TRANSCRIPTS'] === 'true') return transcript;
  return `<${transcript.length} chars redacted — set LOG_TRANSCRIPTS=true to log>`;
}

interface AccountRow {
  jar_account_id: number;
  name:           string;
  current_amount: number;
}

function buildPlannerContext(db: ReturnType<typeof getDb>): Parameters<typeof planFromTranscript>[1] {
  const latestScore = db
    .prepare(`SELECT * FROM score_log ORDER BY logged_at DESC LIMIT 1`)
    .get() as ScoreLogRow | undefined;

  const profile = db
    .prepare(`SELECT * FROM user_profile WHERE id = 1`)
    .get() as UserProfileRow | undefined;

  const jarAccounts = db
    .prepare(
      `SELECT jar_account_id, name, current_amount FROM goals
       WHERE jar_account_id IS NOT NULL AND enabled = 1`,
    )
    .all() as AccountRow[];

  const salaryAmt      = profile?.salary_amount ?? null;
  const balanceScore   = latestScore?.balance_component ?? 50;
  const estimatedBalance = salaryAmt !== null
    ? salaryAmt * (balanceScore / 100)
    : balanceScore * 20;

  return {
    balanceEur: estimatedBalance,
    accounts:   jarAccounts.map((g) => ({
      id:          g.jar_account_id,
      description: g.name,
      balanceEur:  g.current_amount,
    })),
  };
}

export async function registerVoiceRoute(
  fastify: FastifyInstance,
  triggerTick?: () => Promise<void>,
  getAID?: () => number,
): Promise<void> {

  // ── POST /api/voice ──────────────────────────────────────────────────────────
  fastify.post('/api/voice', async (req: FastifyRequest, reply: FastifyReply) => {
    // Read all multipart parts: audio file + optional context fields
    let audioBuffer: Buffer | null = null;
    let mimeType                   = 'audio/webm';
    let pendingPlanId: string | null           = null;
    let activeInterventionId: string | null    = null;
    let activeInterventionPlanId: string | null = null;

    try {
      for await (const part of req.parts()) {
        if (part.type === 'file' && part.fieldname === 'audio') {
          audioBuffer = await part.toBuffer();
          mimeType    = part.mimetype || 'audio/webm';
        } else if (part.type === 'field') {
          const val = String(part.value).trim();
          // These ids are used to confirm/execute plans — validate their shape
          // before they can be used to look anything up.
          if (part.fieldname === 'pendingPlanId'            && val) pendingPlanId            = parseOr400(UuidParam, val, 'pendingPlanId');
          if (part.fieldname === 'activeInterventionId'     && val) activeInterventionId     = parseOr400(IdParam,   val, 'activeInterventionId');
          if (part.fieldname === 'activeInterventionPlanId' && val) activeInterventionPlanId = parseOr400(UuidParam, val, 'activeInterventionPlanId');
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.warn({ err: message }, 'multipart parse failed');
      return reply.status(400).send({ error: 'Could not read the uploaded audio' });
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return reply.status(400).send({ error: 'No audio file uploaded' });
    }

    // ── Step 1: Speech-to-text ─────────────────────────────────────────────────
    let transcript: string;
    try {
      transcript = await transcribeAudio(audioBuffer, mimeType);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[voice] STT failed:', message);
      return reply.status(502).send({ error: 'Transcription unavailable' });
    }

    if (!transcript) {
      return reply.status(422).send({ error: 'No speech detected in audio' });
    }

    console.log(`[voice] Transcript: ${redactTranscript(transcript)}`);

    // ── Step 2: Classify intent ────────────────────────────────────────────────
    const intent = await classifyIntent(transcript);
    console.log(`[voice] Intent: ${intent}`);

    const db = getDb();

    // ── Step 3: Route by intent ────────────────────────────────────────────────

    // ── Confirm pending plan or active intervention ──────────────────────────
    if (intent === 'confirm') {
      if (pendingPlanId) {
        try {
          await confirmPlan(pendingPlanId);
          await executePlan(pendingPlanId);
          return reply.send({
            kind:            'confirmed',
            planId:          pendingPlanId,
            spokenResponse:  'Confirmed. Your plan is executing now.',
            transcript,
          });
        } catch (err: unknown) {
          req.log.warn({ err }, 'voice plan action failed');
          const safe = err instanceof Error && err.name === 'StepValidationError'
            ? err.message
            : 'Unable to complete that action';
          return reply.status(400).send({ error: safe });
        }
      }

      if (activeInterventionPlanId) {
        // Intervention has an execution plan — confirming means the transaction
        // is legitimate (allow it through by cancelling the block plan)
        try {
          await cancelPlan(activeInterventionPlanId);
          if (activeInterventionId) resolveIntervention(db, activeInterventionId, 'DISMISSED');
          return reply.send({
            kind:           'confirmed',
            spokenResponse: 'Transaction authorized. The alert has been dismissed.',
            transcript,
          });
        } catch (err: unknown) {
          req.log.warn({ err }, 'voice plan action failed');
          const safe = err instanceof Error && err.name === 'StepValidationError'
            ? err.message
            : 'Unable to complete that action';
          return reply.status(400).send({ error: safe });
        }
      }

      if (activeInterventionId) {
        resolveIntervention(db, activeInterventionId, 'DISMISSED');
        return reply.send({
          kind:           'confirmed',
          spokenResponse: 'Alert dismissed.',
          transcript,
        });
      }

      return reply.send({
        kind:           'response',
        action:         'confirm',
        spokenResponse: 'Nothing pending to confirm.',
        transcript,
      });
    }

    // ── Deny pending plan or active intervention ──────────────────────────────
    if (intent === 'deny') {
      if (pendingPlanId) {
        try {
          await cancelPlan(pendingPlanId);
          return reply.send({
            kind:           'denied',
            planId:         pendingPlanId,
            spokenResponse: 'Plan cancelled.',
            transcript,
          });
        } catch (err: unknown) {
          req.log.warn({ err }, 'voice plan action failed');
          const safe = err instanceof Error && err.name === 'StepValidationError'
            ? err.message
            : 'Unable to complete that action';
          return reply.status(400).send({ error: safe });
        }
      }

      if (activeInterventionPlanId) {
        // Denying (blocking) a fraud — execute the CANCEL_DRAFT plan
        try {
          await confirmPlan(activeInterventionPlanId);
          await executePlan(activeInterventionPlanId);
          if (activeInterventionId) resolveIntervention(db, activeInterventionId, 'EXECUTED');
          return reply.send({
            kind:           'denied',
            spokenResponse: 'Transaction blocked. The fraud intervention has been executed.',
            transcript,
          });
        } catch (err: unknown) {
          req.log.warn({ err }, 'voice plan action failed');
          const safe = err instanceof Error && err.name === 'StepValidationError'
            ? err.message
            : 'Unable to complete that action';
          return reply.status(400).send({ error: safe });
        }
      }

      if (activeInterventionId) {
        resolveIntervention(db, activeInterventionId, 'DISMISSED');
        return reply.send({
          kind:           'denied',
          spokenResponse: 'Alert dismissed.',
          transcript,
        });
      }

      return reply.send({
        kind:           'response',
        action:         'deny',
        spokenResponse: 'Nothing pending to deny.',
        transcript,
      });
    }

    // ── System commands ───────────────────────────────────────────────────────
    if (intent === 'trigger_dream') {
      const result = await handleTriggerDream(db, wsEmit);
      return reply.send({ kind: 'response', action: intent, ...result, transcript });
    }

    if (intent === 'fund_sandbox') {
      const result = await handleFundSandbox(db, getAID?.() ?? 1, triggerTick);
      return reply.send({ kind: 'response', action: intent, ...result, transcript });
    }

    if (intent === 'simulate_fraud') {
      const result = handleSimulateFraud(db, getAID?.() ?? 1, triggerTick);
      return reply.send({ kind: 'response', action: intent, ...result, transcript });
    }

    if (intent === 'simulate_salary') {
      const result = handleSimulateSalary(db, getAID?.() ?? 1, triggerTick);
      return reply.send({ kind: 'response', action: intent, ...result, transcript });
    }

    if (intent === 'read_score')         return reply.send({ kind: 'response', action: intent, ...handleReadScore(db),         transcript });
    if (intent === 'read_interventions') return reply.send({ kind: 'response', action: intent, ...handleReadInterventions(db), transcript });
    if (intent === 'read_forecast')      return reply.send({ kind: 'response', action: intent, ...handleReadForecast(db),      transcript });
    if (intent === 'read_dream_report')  return reply.send({ kind: 'response', action: intent, ...handleReadDreamReport(db),   transcript });

    // ── Financial command — existing planner flow ─────────────────────────────
    const context = buildPlannerContext(db);
    const { narratedText, steps } = await planFromTranscript(transcript, context);
    const plan = await createExecutionPlan(steps, narratedText);
    wsEmit({ type: 'plan_update', payload: plan });

    return reply.send({
      kind:         'plan',
      planId:       plan.id,
      narratedText: plan.narratedText,
      steps:        plan.steps,
      transcript,
    });
  });

  // ── POST /api/voice/speak ──────────────────────────────────────────────────
  fastify.post('/api/voice/speak', async (req: FastifyRequest, reply: FastifyReply) => {
    const { text } = parseOr400(SpeakBody, req.body ?? {}, 'body');

    try {
      const audioBuffer = await textToSpeech(text);
      return reply
        .header('Content-Type', 'audio/mpeg')
        .header('Content-Length', String(audioBuffer.length))
        .send(audioBuffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[voice] TTS failed:', message);
      // Upstream errors can echo the API key holder / quota detail — keep it internal.
      return reply.status(502).send({ error: 'Speech synthesis unavailable' });
    }
  });
}
