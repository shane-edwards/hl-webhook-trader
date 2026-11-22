// Our signing must match the official Hyperliquid Python SDK byte for byte.
// tests/signing-vectors.json was produced by that SDK (sign_l1_action / sign_agent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { approveAgentTypedData, recoverApproveAgentSigner, signL1Action, type ApproveAgentAction } from '../lib/hyperliquid/signing';
import { formatPrice, formatSize } from '../lib/hyperliquid/format';

const vectors = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'signing-vectors.json'), 'utf8'));
const wallet = new ethers.Wallet('0x' + '11'.repeat(32));

test('L1 action signatures match the official SDK (IOC order, stop-loss trigger, cancel)', async () => {
  assert.equal(wallet.address, vectors.address);
  assert.deepEqual(await signL1Action(wallet, vectors.ioc.action, vectors.ioc.nonce, true), vectors.ioc.mainnet);
  assert.deepEqual(await signL1Action(wallet, vectors.ioc.action, vectors.ioc.nonce, false), vectors.ioc.testnet);
  assert.deepEqual(await signL1Action(wallet, vectors.sl.action, vectors.sl.nonce, true), vectors.sl.mainnet);
  assert.deepEqual(await signL1Action(wallet, vectors.cancel.action, vectors.cancel.nonce, true), vectors.cancel.mainnet);
});

test('our number formatting produces the same wire strings as the SDK', () => {
  assert.equal(formatPrice(61235, 5), vectors.ioc.action.orders[0].p);
  assert.equal(formatSize(0.00123, 5), vectors.ioc.action.orders[0].s);
  assert.equal(formatPrice(58000, 5), vectors.sl.action.orders[0].t.trigger.triggerPx);
});

test('approveAgent typed data matches the SDK and recovers the signer', async () => {
  const action = vectors.agent.action as ApproveAgentAction;
  const { domain, types, message } = approveAgentTypedData(action);
  const sig = ethers.Signature.from(await wallet.signTypedData(domain, types, message));
  assert.deepEqual({ r: sig.r, s: sig.s, v: sig.v }, vectors.agent.signature);
  assert.equal(recoverApproveAgentSigner(action, sig.serialized), wallet.address);
  // A signature made on a different chain id must not verify as this wallet.
  assert.notEqual(recoverApproveAgentSigner({ ...action, signatureChainId: '0xa4b1' }, sig.serialized), wallet.address);
});
