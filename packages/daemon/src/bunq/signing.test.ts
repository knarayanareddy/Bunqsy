import assert from 'node:assert/strict';
import { generateKeyPair, signRequestBody, verifyWebhookSignature } from './signing.js';

/**
 * Offline signing round-trip test — proves RSA-2048 + SHA256 + base64 contract
 * without hitting the bunq API. QA requirement: must pass before Phase 0.
 * Run: npx tsx packages/daemon/src/bunq/signing.test.ts
 */

function runTests(): void {
  // 1. Key generation
  const { privateKeyPem, publicKeyPem } = generateKeyPair();
  assert.ok(privateKeyPem.includes('BEGIN PRIVATE KEY'), 'private key PEM header');
  assert.ok(publicKeyPem.includes('BEGIN PUBLIC KEY'), 'public key PEM header');

  // 2. Sign + verify round-trip
  const bodies = [
    JSON.stringify({ test: true }),
    '',
    JSON.stringify({ amount: { value: '10.00', currency: 'EUR' }, description: 'hello' }),
  ];
  for (const body of bodies) {
    const sig = signRequestBody(body, privateKeyPem);
    assert.ok(sig.length > 100, 'signature base64 length');
    assert.equal(verifyWebhookSignature(body, sig, publicKeyPem), true, `verify round-trip for "${body.slice(0, 30)}"`);
    // Tampered body must fail
    assert.equal(verifyWebhookSignature(body + 'x', sig, publicKeyPem), false, 'tampered body must fail');
  }

  // 3. Cross-key must fail
  const { publicKeyPem: otherPub } = generateKeyPair();
  const sig = signRequestBody('hello', privateKeyPem);
  assert.equal(verifyWebhookSignature('hello', sig, otherPub), false, 'wrong public key must fail');

  // 4. Malformed signature must return false, not throw
  assert.equal(verifyWebhookSignature('hello', 'not-base64!!', publicKeyPem), false, 'malformed sig returns false');

  console.log('✅ signing.test.ts — all 4 suites passed (keygen, round-trip, cross-key, malformed)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}

export { runTests };
