// Browser-side wallet connection. Two routes to the same EIP-1193 provider:
//  - "injected": a wallet that lives in the browser (an extension, or a mobile
//    wallet's built-in dApp browser such as SafePal's).
//  - "walletconnect": scan a QR code / deep-link to a mobile wallet. Needs
//    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (free at cloud.reown.com).
// The wallet is only ever asked for its address and one typed-data signature.

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  disconnect?: () => Promise<void>;
}

export interface ConnectedWallet {
  provider: Eip1193Provider;
  address: string;
  chainId: number;
  kind: 'injected' | 'walletconnect';
}

type InjectedWindow = Window & { ethereum?: Eip1193Provider; safepalProvider?: Eip1193Provider };

export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';

export function injectedProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  const w = window as InjectedWindow;
  return w.safepalProvider ?? w.ethereum ?? null;
}

async function describe(provider: Eip1193Provider, kind: ConnectedWallet['kind']): Promise<ConnectedWallet> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('The wallet did not share an address');
  const chainHex = (await provider.request({ method: 'eth_chainId' })) as string | number;
  const chainId = typeof chainHex === 'number' ? chainHex : parseInt(chainHex, 16);
  return { provider, address: accounts[0], chainId, kind };
}

export async function connectInjected(): Promise<ConnectedWallet> {
  const provider = injectedProvider();
  if (!provider) throw new Error('No wallet found in this browser');
  return describe(provider, 'injected');
}

export async function connectWalletConnect(): Promise<ConnectedWallet> {
  if (!walletConnectProjectId) throw new Error('WalletConnect is not configured');
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  const provider = await EthereumProvider.init({
    projectId: walletConnectProjectId,
    // Signing needs no particular chain; offer the common ones so any wallet can pair.
    optionalChains: [42161, 1, 56, 137, 10, 8453],
    showQrModal: true,
    metadata: {
      name: 'HL Trader',
      description: 'Approve a trade-only key for Hyperliquid',
      url: window.location.origin,
      icons: [],
    },
  });
  await provider.connect();
  return describe(provider as unknown as Eip1193Provider, 'walletconnect');
}

/** Asks the wallet to sign EIP-712 typed data and returns the 65-byte hex signature. */
export async function signTypedData(wallet: ConnectedWallet, typedData: unknown): Promise<string> {
  const signature = await wallet.provider.request({
    method: 'eth_signTypedData_v4',
    params: [wallet.address, JSON.stringify(typedData)],
  });
  if (typeof signature !== 'string') throw new Error('The wallet returned no signature');
  return signature;
}

/** Wallet errors arrive in many shapes; turn the common ones into plain sentences. */
export function walletErrorMessage(err: unknown): string {
  const e = err as { code?: number; message?: string } | undefined;
  if (e?.code === 4001 || /reject|denied|cancel/i.test(e?.message ?? '')) return 'You cancelled the request in your wallet.';
  return e?.message ?? 'Wallet request failed';
}
