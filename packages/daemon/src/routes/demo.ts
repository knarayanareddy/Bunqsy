import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../memory/db.js';
import { createExecutionPlan, confirmPlan, executePlan } from '../bunq/execute.js';
import { assertDemoAllowed } from '../security/demo-guard.js';

// ─── Seed row schema ──────────────────────────────────────────────────────────
// [id, amount, counterpartyName, description, category, isRecurring(0|1), daysAgo, hour]
type SeedRow = [string, number, string, string, string, 0 | 1, number, number];

function isoDate(daysBack: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(hour, 30, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ─── Demo seed: ~40 realistic transactions spanning 35 days ───────────────────
//
// Showcases: salary detection, rent detection, subscription watcher, velocity
// spike (impulse buy), fraud signal (large unknown merchant), goal contributions.
const SEED: SeedRow[] = [
  // ── Salary (recurring, large inbound) ─────────────────────────────────────
  ['demo-1000', 3500.00, 'Werkgever Nederland BV', 'SALARISBETALING APRIL 2026',  'income',   1, 5,  9],
  ['demo-1001', 3500.00, 'Werkgever Nederland BV', 'SALARISBETALING MAART 2026',  'income',   1, 35, 9],

  // ── Rent (recurring, day after salary) ────────────────────────────────────
  ['demo-1010', -1250.00, 'ING Verhuurder Amsterdam BV', 'HUUR APRIL 2026',        'housing',  1, 4,  8],
  ['demo-1011', -1250.00, 'ING Verhuurder Amsterdam BV', 'HUUR MAART 2026',        'housing',  1, 34, 8],

  // ── Subscriptions (watcher bait: 4+ active) ───────────────────────────────
  ['demo-1020',  -15.99, 'Netflix Netherlands BV',  'Netflix maandelijks',         'entertainment', 1, 6,  11],
  ['demo-1021',   -9.99, 'Spotify AB',              'Spotify Premium',             'entertainment', 1, 6,  11],
  ['demo-1022',  -34.99, 'SportCity Fitness',       'SportCity lidmaatschap',      'health',        1, 10, 10],
  ['demo-1023',  -39.99, 'KPN Mobile B.V.',         'KPN abonnement april',        'utilities',     1, 15, 10],
  ['demo-1024',  -14.99, 'Disney+ Netherlands',     'Disney+ maandelijks',         'entertainment', 1, 18, 11],
  ['demo-1025',   -4.99, 'Apple iCloud',            'iCloud 200 GB',               'utilities',     1, 20, 11],

  // ── Groceries (steady baseline spend) ─────────────────────────────────────
  ['demo-1030',  -67.40, 'Albert Heijn #1452',      'Boodschappen',                'groceries', 0, 0,  18],
  ['demo-1031',  -82.30, 'Albert Heijn #1452',      'Boodschappen',                'groceries', 0, 7,  17],
  ['demo-1032',  -55.60, 'Jumbo Supermarkt',        'Boodschappen',                'groceries', 0, 14, 16],
  ['demo-1033',  -93.20, 'Albert Heijn #1452',      'Boodschappen',                'groceries', 0, 21, 18],
  ['demo-1034',  -71.80, 'Albert Heijn #1452',      'Boodschappen',                'groceries', 0, 28, 17],

  // ── Dining / coffee ────────────────────────────────────────────────────────
  ['demo-1040',  -12.80, 'Restaurant Plein Amsterdam', 'Lunch',                    'dining', 0, 1,  13],
  ['demo-1041',   -4.20, 'Bagels & Beans',             'Koffie en broodje',        'dining', 0, 2,  9],
  ['demo-1042',  -22.50, 'Café Brasserie De Kom',      'Diner',                    'dining', 0, 3,  19],
  ['demo-1043',   -3.80, 'AH to go Station CS',        'Lunch onderweg',           'dining', 0, 4,  12],
  ['demo-1044',   -8.90, "McDonald's Amsterdam CS",    'Fastfood',                 'dining', 0, 8,  13],
  ['demo-1045',  -19.40, 'Sushi Garden Amsterdam',     'Diner',                    'dining', 0, 11, 20],
  ['demo-1046',   -4.50, 'Starbucks Leidsestraat',     'Koffie',                   'dining', 0, 12, 8],
  ['demo-1047',  -14.20, 'Pasta e Vino Trattoria',     'Lunch',                    'dining', 0, 16, 13],

  // ── Transport ──────────────────────────────────────────────────────────────
  ['demo-1050',  -42.00, 'NS Reizen',                  'OV jaarkaart laad',        'transport', 0, 5,  8],
  ['demo-1051',   -2.90, 'GVB OV-Chip',                'Tram rit Amsterdam',       'transport', 0, 9,  8],
  ['demo-1052',   -8.40, 'Bolt Taxi Amsterdam',         'Rit naar Schiphol',       'transport', 0, 13, 7],

  // ── ⚡ Impulse buy — velocity spike trigger ─────────────────────────────────
  ['demo-1060', -189.99, 'Amazon Marketplace',          'Bluetooth speaker Anker', 'shopping', 0, 2, 21],
  ['demo-1061',  -74.99, 'MediaMarkt Online',           'USB-C hub 10-in-1',       'shopping', 0, 3, 22],

  // ── ⚠️ Suspicious large — fraud shadow signal ───────────────────────────────
  ['demo-1070', -450.00, 'TechStoreBV - Ref: 882991X',  'Aankoop ref 882991X',    'shopping', 0, 1, 23],

  // ── Utilities / bills ──────────────────────────────────────────────────────
  ['demo-1080',  -85.00, 'Vattenfall Energie',          'Energierekening april',   'utilities', 1, 22, 10],
  ['demo-1081',  -28.40, 'Ziggo Internet',              'Internet abonnement',     'utilities', 1, 25, 10],

  // ── ATM withdrawals ────────────────────────────────────────────────────────
  ['demo-1090', -100.00, 'Geldautomaat ING Amsterdam',  'Contant opname',          'other', 0, 17, 14],
  ['demo-1091',  -60.00, 'ATM Rabobank Zuid',            'Contant opname',          'other', 0, 23, 16],

  // ── Shopping ───────────────────────────────────────────────────────────────
  ['demo-1100',  -24.80, 'Action Retail B.V.',           'Huishoudartikelen',       'shopping', 0, 19, 15],
  ['demo-1101', -156.00, 'Zara Amsterdam',               'Kleding',                 'shopping', 0, 24, 14],
  ['demo-1102',  -32.50, 'Bol.com',                      'Online bestelling',       'shopping', 0, 26, 11],
  ['demo-1103',  -18.90, 'HEMA Online',                  'Woonaccessoires',         'shopping', 0, 27, 10],
  ['demo-1104',   -7.60, 'Kruidvat',                     'Drogisterij',             'shopping', 0, 29, 11],

  // ── 🎯 Savings contribution (goal milestone signal) ────────────────────────
  ['demo-1110',  500.00, 'Eigen rekening SPAAR', 'Overboeking spaardoel vakantie', 'savings', 0, 6, 10],
  ['demo-1111',  250.00, 'Eigen rekening SPAAR', 'Overboeking spaardoel auto',     'savings', 0, 20, 10],
];

import { v4 as uuidv4 } from 'uuid';

export async function registerDemoRoute(
  fastify: FastifyInstance,
  triggerTick?: () => Promise<void>,
  getAID?: () => number,
): Promise<void> {
  fastify.post('/api/demo/reset', async (_req: FastifyRequest, reply: FastifyReply) => {
    assertDemoAllowed('Demo reset');
    const db = getDb();
    const AID = getAID?.() ?? 1;

    const stmt = db.prepare(`
      INSERT INTO transactions
        (id, bunq_account_id, amount, currency, counterparty_name, counterparty_iban,
         description, category, is_recurring, created_at, synced_at)
      VALUES (?, ?, ?, 'EUR', ?, NULL, ?, ?, ?, ?, datetime('now'))
    `);

    db.transaction(() => {
      // Clear tables
      db.prepare(`DELETE FROM dream_sessions`).run();
      db.prepare(`DELETE FROM patterns`).run();
      db.prepare(`DELETE FROM interventions`).run();
      db.prepare(`DELETE FROM forecast_cache`).run();
      db.prepare(`DELETE FROM transactions`).run();
      db.prepare(`DELETE FROM goals`).run();
      db.prepare(`DELETE FROM user_profile`).run();

      // Seed profile
      db.prepare(`
        INSERT INTO user_profile (id, name, salary_day, salary_amount, rent_amount, rent_day)
        VALUES (1, 'Bunqsy User', 25, 3500.00, 1250.00, 1)
      `).run();

      // Seed goals
      const goals = [
        ['goal-1', '🏠 Rent Reserve',   6000, 950,  null, AID + 1],
        ['goal-2', '🛡️ Emergency Fund', 6000, 3200, null, AID + 2],
        ['goal-3', '🗺️ Amsterdam Trip', 1000, 680,  '2026-06-15', AID + 3],
      ];
      const goalStmt = db.prepare(`
        INSERT INTO goals (id, name, target_amount, current_amount, target_date, jar_account_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const g of goals) goalStmt.run(...g);

      // Insert seed transactions
      for (const [id, amount, cName, desc, cat, isRec, days, hour] of SEED) {
        stmt.run(id, AID, amount, cName, desc, cat, isRec, isoDate(days, hour));
      }
    })();

    if (triggerTick) void triggerTick();
    return reply.send({ ok: true, seeded: SEED.length });
  });

  // ─── Simulate Salary ───
  fastify.post('/api/demo/salary', async (_req, reply) => {
    // Inserts a fabricated €3500 credit into the ledger.
    assertDemoAllowed('Salary simulation');
    const db = getDb();
    const AID = getAID?.() ?? 1;

    console.log(`[demo] Simulating salary for account ${AID}`);
    db.prepare(`
      INSERT INTO transactions (id, bunq_account_id, amount, currency, counterparty_name, description, category, created_at, synced_at)
      VALUES (?, ?, 3500.00, 'EUR', 'Werkgever Nederland BV', 'SALARISBETALING simulation', 'income', datetime('now'), datetime('now'))
    `).run(uuidv4(), AID);

    if (triggerTick) {
      console.log('[demo] Triggering manual heartbeat tick...');
      // Small delay to ensure DB persistence if needed by tick
      setTimeout(() => {
        void triggerTick!().catch(err => console.error('[demo] Manual tick failed:', err));
      }, 100);
    }
    return reply.send({ ok: true });
  });

  // ─── Fund sandbox via sugardaddy@bunq.com ───
  fastify.post('/api/demo/fund-sandbox', async (_req: FastifyRequest, reply: FastifyReply) => {
    assertDemoAllowed('Sandbox funding');

    const AID = getAID?.() ?? 1;
    const db  = getDb();

    const sessionRow = db
      .prepare(`SELECT user_id FROM sessions ORDER BY created_at DESC LIMIT 1`)
      .get() as { user_id: number } | undefined;

    if (!sessionRow) return reply.status(500).send({ error: 'No active session' });

    console.log(`[demo] Requesting sandbox funds for account ${AID}`);

    const plan = await createExecutionPlan(
      [{
        id:          uuidv4(),
        type:        'SANDBOX_FUND',
        description: 'Request €500 from bunq Sugar Daddy sandbox alias',
        payload:     { accountId: AID, amount: '500' },
      }],
      'Requesting €500 from the bunq sandbox Sugar Daddy to fund your test account.',
    );

    // Button click is the explicit user confirmation — satisfy PLAN_BEFORE_ACT
    await confirmPlan(plan.id);
    await executePlan(plan.id);

    if (triggerTick) {
      setTimeout(() => {
        void triggerTick!().catch(err => console.error('[demo] Post-fund tick failed:', err));
      }, 1500);
    }

    return reply.send({ ok: true, planId: plan.id, amount: '500', accountId: AID });
  });

  // ─── Simulate Fraud ───
  fastify.post('/api/demo/fraud', async (_req, reply) => {
    // Inserts a fabricated suspicious debit into the ledger.
    assertDemoAllowed('Fraud simulation');
    const db = getDb();
    const AID = getAID?.() ?? 1;

    console.log(`[demo] Simulating fraud for account ${AID}`);
    // Match the screenshot: €500.00 (USD), Unknown LLC, 02:14 AM
    const date = new Date();
    date.setHours(2, 14, 0, 0);
    
    db.prepare(`
      INSERT INTO transactions (id, bunq_account_id, amount, currency, counterparty_name, description, category, created_at, synced_at)
      VALUES (?, ?, -500.00, 'USD', 'Unknown LLC', 'CARD PURCHASE Ref: 882991X', 'shopping', ?, datetime('now'))
    `).run(uuidv4(), AID, date.toISOString().slice(0, 19).replace('T', ' '));

    if (triggerTick) {
      console.log('[demo] Triggering manual heartbeat tick...');
      setTimeout(() => {
        void triggerTick!().catch(err => console.error('[demo] Manual tick failed:', err));
      }, 100);
    }
    return reply.send({ ok: true });
  });
}
