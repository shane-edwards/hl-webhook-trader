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
  const [{ default: SignClient }, { default: QRCode }] = await Promise.all([
    import('@walletconnect/sign-client'), import('qrcode'),
  ]);
  const client = await SignClient.init({
    projectId: walletConnectProjectId,
    metadata: { name: 'HL Trader', description: 'Approve a trading key for Hyperliquid', url: window.location.origin, icons: [] },
  });
  const { uri, approval } = await client.connect({
    optionalNamespaces: { eip155: {
      chains: [42161, 1, 56, 137, 10, 8453].map(id => `eip155:${id}`),
      methods: ['eth_signTypedData_v4'], events: ['accountsChanged', 'chainChanged'],
    } },
  });
  const pending = approval();
  const dialog = document.createElement('dialog');
  dialog.className = 'rounded-xl p-6 bg-white text-black max-w-sm w-full';
  dialog.setAttribute('aria-label', 'Connect your wallet');
  const title = document.createElement('h2');
  title.textContent = 'Connect your wallet';
  const qr = document.createElement('img');
  qr.alt = 'Scan with your wallet to connect';
  qr.width = 288; qr.height = 288;
  const link = document.createElement('a');
  link.textContent = 'Open wallet';
  link.className = 'block underline my-3';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.className = 'rounded border px-4 py-2';
  dialog.append(title, qr, link, cancel);
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    const stop = () => { cancelled = true; reject(new Error('Wallet connection cancelled')); };
    cancel.onclick = stop;
    dialog.addEventListener('cancel', stop);
    timeout = setTimeout(stop, 120_000);
  });
  // If approval arrives after dismissal, close that unused session as well.
  void pending.then(session => { if (cancelled) return client.disconnect({ topic: session.topic, reason: { code: 6000, message: 'Connection cancelled' } }); }).catch(() => {});
  try {
    if (uri) {
      qr.src = await QRCode.toDataURL(uri, { width: 288, margin: 2 });
      link.href = uri;
      document.body.append(dialog);
      dialog.showModal();
    }
    const session = await Promise.race([pending, cancellation]);
    const account = session.namespaces.eip155?.accounts[0];
    if (!account) throw new Error('The wallet did not share an Ethereum account');
    const [, chain, address] = account.split(':');
    const chainId = Number(chain);
    const provider: Eip1193Provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        return client.request({ topic: session.topic, chainId: `eip155:${chainId}`, request: { method, params } });
      },
      async disconnect() { await client.disconnect({ topic: session.topic, reason: { code: 6000, message: 'Disconnected' } }); },
    };
    return { provider, address, chainId, kind: 'walletconnect' };
  } finally {
    clearTimeout(timeout);
    dialog.close(); dialog.remove();
  }
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
