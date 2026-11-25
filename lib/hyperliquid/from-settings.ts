import { createHLClient, type HyperliquidClient } from './client';
import { decrypt } from '@/lib/encryption';

interface CredentialSettings {
  user_id?: string | null;
  hl_private_key_encrypted?: string | null;
  hl_wallet_address?: string | null;
  is_testnet?: boolean | null;
}

/**
 * The deployment-wide key from HL_PRIVATE_KEY, if this account may use it.
 * With HL_OWNER_USER_ID set, only that account gets it; every other account
 * falls back to its own stored key. Without HL_OWNER_USER_ID it applies to
 * every account, so set it whenever HL_PRIVATE_KEY is set.
 */
export function envKeyFor(userId: string | null | undefined): string | undefined {
  const envKey = process.env.HL_PRIVATE_KEY || undefined;
  const owner = process.env.HL_OWNER_USER_ID;
  return envKey && (!owner || userId === owner) ? envKey : undefined;
}

/**
 * Builds an exchange client from a settings row. The HL_* env vars, when set,
 * override the stored credentials (for the account named in HL_OWNER_USER_ID,
 * or for every account when that is not set). Returns null when no key is configured.
 */
export function hlClientFromSettings(settings: CredentialSettings | null | undefined): HyperliquidClient | null {
  const envKey = envKeyFor(settings?.user_id);
  const encrypted = settings?.hl_private_key_encrypted;
  if (!envKey && !encrypted) return null;

  return createHLClient({
    requireCoordination: true,
    privateKey: envKey ?? decrypt(encrypted!),
    accountAddress: envKey ? process.env.HL_WALLET_ADDRESS : settings?.hl_wallet_address,
    // Testnet if either source says so: a stale flag should never route test orders to mainnet.
    isTestnet: process.env.HL_TESTNET === 'true' || settings?.is_testnet === true,
  });
}

/**
 * A client for reading public market data only (candles, prices). It signs
 * with a throwaway key that controls nothing, and always reads mainnet, where
 * the real prices are.
 */
export function marketDataClient(): HyperliquidClient {
  return createHLClient({ privateKey: '0x' + '01'.repeat(32), isTestnet: false });
}
