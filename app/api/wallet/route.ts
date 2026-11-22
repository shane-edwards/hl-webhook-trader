import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { decrypt, encrypt } from '@/lib/encryption';
import { approveAgentWalletPayload, recoverApproveAgentSigner, type ApproveAgentAction } from '@/lib/hyperliquid/signing';

export const dynamic = 'force-dynamic';

// Connecting a wallet never gives this app the wallet's own key. Instead:
//   1. PUT    the server creates a fresh trading key and returns an
//             "approve agent" message for the wallet to sign.
//   2. POST   the signed approval is sent to Hyperliquid. Once accepted, the
//             trading key is stored (encrypted). It can place and cancel
//             orders for the account but cannot withdraw or transfer funds.
//   3. DELETE forgets the trading key.
const AGENT_NAME = 'hltrader';
const APPROVAL_WINDOW_MS = 10 * 60_000;
const exchangeUrl = (testnet: boolean) => `https://api.hyperliquid${testnet ? '-testnet' : ''}.xyz/exchange`;

async function context() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const service = createServiceClient();
  const { data: settings } = await service.from('settings').select('*').eq('user_id', user.id).single();
  return { user, service, settings };
}

export async function PUT(request: Request) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!ctx.settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const address = String(body?.address ?? '');
  const chainId = Number(body?.chainId);
  if (!ethers.isAddress(address)) return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  if (!Number.isInteger(chainId) || chainId <= 0) return NextResponse.json({ error: 'Invalid chain id' }, { status: 400 });

  let sealedKey: string;
  const agent = ethers.Wallet.createRandom();
  try {
    // The key is handed back sealed (AES-256-GCM, server secret); the browser cannot read it.
    sealedKey = encrypt(agent.privateKey);
  } catch {
    return NextResponse.json({ error: 'ENCRYPTION_KEY is not set on the server' }, { status: 500 });
  }

  const isTestnet = process.env.HL_TESTNET === 'true' || ctx.settings.is_testnet === true;
  const action: ApproveAgentAction = {
    type: 'approveAgent',
    hyperliquidChain: isTestnet ? 'Testnet' : 'Mainnet',
    signatureChainId: '0x' + chainId.toString(16),
    agentAddress: agent.address,
    agentName: AGENT_NAME,
    nonce: Date.now(),
  };
  return NextResponse.json({ action, typedData: approveAgentWalletPayload(action), sealedKey, isTestnet });
}

export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const action = body?.action as ApproveAgentAction | undefined;
  const address = String(body?.address ?? '');
  const signature = String(body?.signature ?? '');
  const sealedKey = String(body?.sealedKey ?? '');
  const bad = (message: string) => NextResponse.json({ error: message }, { status: 400 });

  if (!action || action.type !== 'approveAgent' || !ethers.isAddress(address) || !ethers.isAddress(action.agentAddress)) return bad('Malformed approval');
  if (action.agentName !== AGENT_NAME || !/^0x[0-9a-f]+$/.test(String(action.signatureChainId))) return bad('Malformed approval');
  if (!Number.isInteger(action.nonce) || Math.abs(Date.now() - action.nonce) > APPROVAL_WINDOW_MS) return bad('Approval expired; start again');
  const isTestnet = process.env.HL_TESTNET === 'true' || ctx.settings?.is_testnet === true;
  if (action.hyperliquidChain !== (isTestnet ? 'Testnet' : 'Mainnet')) return bad('Network changed during approval; start again');

  // The sealed key must be one this server created, for exactly this agent address.
  let agentKey: string;
  try {
    agentKey = decrypt(sealedKey);
    if (new ethers.Wallet(agentKey).address.toLowerCase() !== action.agentAddress.toLowerCase()) throw new Error('mismatch');
  } catch {
    return bad('Approval does not match the prepared trading key; start again');
  }

  let sig: ethers.Signature;
  try {
    sig = ethers.Signature.from(signature);
    if (recoverApproveAgentSigner(action, signature).toLowerCase() !== address.toLowerCase()) {
      return bad('The signature was not made by the connected wallet. Make sure the wallet stayed on the same network while signing.');
    }
  } catch {
    return bad('Invalid signature');
  }

  // Hyperliquid expects lowercase addresses in the action it verifies.
  const wire = { ...action, agentAddress: action.agentAddress.toLowerCase() };
  let result: { status?: string; response?: unknown };
  try {
    const res = await fetch(exchangeUrl(isTestnet), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: wire, nonce: action.nonce, signature: { r: sig.r, s: sig.s, v: sig.v } }),
      signal: AbortSignal.timeout(15_000),
    });
    result = await res.json().catch(async () => ({ status: 'err', response: `HTTP ${res.status}` }));
  } catch (err) {
    return NextResponse.json({ error: `Could not reach Hyperliquid: ${err instanceof Error ? err.message : 'unknown error'}` }, { status: 502 });
  }
  if (result.status !== 'ok') {
    const reason = typeof result.response === 'string' ? result.response : JSON.stringify(result.response ?? result);
    return bad(`Hyperliquid rejected the approval: ${reason}. The wallet needs to have deposited to Hyperliquid${isTestnet ? ' testnet' : ''} first.`);
  }

  const { error } = await ctx.service
    .from('settings')
    .update({ hl_private_key_encrypted: sealedKey, hl_wallet_address: ethers.getAddress(address), updated_at: new Date().toISOString() })
    .eq('user_id', ctx.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ connected: true, address: ethers.getAddress(address), agentAddress: action.agentAddress, isTestnet });
}

export async function DELETE() {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Stop automation too: with no key, signals would only produce errors.
  const update: Record<string, unknown> = { hl_private_key_encrypted: null, hl_wallet_address: null, webhook_enabled: false, updated_at: new Date().toISOString() };
  if (ctx.settings?.strategy_enabled !== undefined) update.strategy_enabled = false;
  const { error } = await ctx.service.from('settings').update(update).eq('user_id', ctx.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connected: false });
}
