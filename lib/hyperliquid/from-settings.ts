import { createHLClient, type HyperliquidClient } from './client';
import { decrypt } from '@/lib/encryption';

interface CredentialSettings {
  hl_private_key_encrypted?: string | null;
  hl_wallet_address?: string | null;
  is_testnet?: boolean | null;
}

/**
 * Builds an exchange client from a settings row. The HL_* env vars, when set,
 * override the stored credentials for every user, so only use them on a
 * single-user deployment. Returns null when no key is configured.
 */
export function hlClientFromSettings(settings: CredentialSettings | null | undefined): HyperliquidClient | null {
  const envKey = process.env.HL_PRIVATE_KEY;
  const encrypted = settings?.hl_private_key_encrypted;
  if (!envKey && !encrypted) return null;

  return createHLClient({
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
