import 'dotenv/config';
import { createSession } from '../packages/daemon/src/bunq/auth.js';

/**
 * Phase 0 Gate — Full bunq session validation
 * Spec requires: installation → device-server → session-server must return 200.
 * Alias of test-signing.ts for checklist compatibility.
 * Run: npx tsx scripts/validate-phase-0.ts  → must print ✅ PHASE 0 GATE PASSED
 */
async function validatePhase0() {
  console.log('🛡️  Starting Phase 0 Gate — bunq sandbox session validation...');

  const apiKey = process.env.BUNQ_API_KEY;
  if (!apiKey) {
    console.error('❌ BUNQ_API_KEY is not set in .env');
    process.exit(1);
  }

  try {
    const session = await createSession(apiKey);
    console.log('✅ PHASE 0 GATE PASSED');
    console.log(`   userId=${session.userId} expiresAt=${session.expiresAt.toISOString()}`);
    process.exit(0);
  } catch (err: unknown) {
    console.error('❌ PHASE 0 GATE FAILED');
    try {
      const parsed = JSON.parse((err as Error).message);
      console.error(`   step=${parsed.step} status=${parsed.status}`);
      console.error(`   body=${parsed.body?.slice(0, 400)}`);
    } catch {
      console.error(`   ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

validatePhase0();
