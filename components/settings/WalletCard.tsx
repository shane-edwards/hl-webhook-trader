'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Wallet, Loader2, QrCode, ShieldCheck, Unplug, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import {
  connectInjected, connectWalletConnect, injectedProvider, signTypedData, walletConnectProjectId, walletErrorMessage,
  type ConnectedWallet,
} from '@/lib/wallet/connect';
import { truncateAddress } from '@/lib/utils';

interface Props {
  /** Account currently linked (null when nothing is connected). */
  address: string | null;
  hasKey: boolean;
  isTestnet: boolean;
  /** Called after connecting or disconnecting so the page can reload settings. */
  onChanged: () => void;
}

type Step = 'idle' | 'connecting' | 'signing' | 'confirming' | 'disconnecting';

const STEP_TEXT: Record<Step, string> = {
  idle: '',
  connecting: 'Waiting for your wallet…',
  signing: 'Check your wallet and sign the approval…',
  confirming: 'Registering the trading key with Hyperliquid…',
  disconnecting: 'Disconnecting…',
};

export function WalletCard({ address, hasKey, isTestnet, onChanged }: Props) {
  const [step, setStep] = useState<Step>('idle');
  const [hasInjected, setHasInjected] = useState(false);
  const connected = hasKey && !!address;
  const busy = step !== 'idle';

  useEffect(() => { setHasInjected(injectedProvider() !== null); }, []);

  async function connect(kind: 'injected' | 'walletconnect') {
    let wallet: ConnectedWallet | null = null;
    try {
      setStep('connecting');
      wallet = kind === 'injected' ? await connectInjected() : await connectWalletConnect();

      const prep = await fetch('/api/wallet', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: wallet.address, chainId: wallet.chainId }),
      });
      const prepared = await prep.json();
      if (!prep.ok) throw new Error(prepared.error ?? 'Could not prepare the approval');

      setStep('signing');
      const signature = await signTypedData(wallet, prepared.typedData);

      setStep('confirming');
      const res = await fetch('/api/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: prepared.action, address: wallet.address, signature, sealedKey: prepared.sealedKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Approval failed');

      toast.success(`Wallet connected: ${truncateAddress(data.address)}`);
      onChanged();
    } catch (err) {
      toast.error(walletErrorMessage(err), { duration: 12000 });
    } finally {
      // The wallet session is only needed for the one signature.
      if (wallet?.kind === 'walletconnect') wallet.provider.disconnect?.().catch(() => {});
      setStep('idle');
    }
  }

  async function disconnect() {
    setStep('disconnecting');
    try {
      const res = await fetch('/api/wallet', { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not disconnect');
      toast.success('Wallet disconnected. Webhook, daily strategy and Crypto Autopilot were turned off.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setStep('idle');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-primary" />
          <CardTitle className="text-base">Wallet</CardTitle>
          <Badge variant={connected ? 'profit' : 'secondary'} className="ml-auto">{connected ? 'CONNECTED' : 'NOT CONNECTED'}</Badge>
        </div>
        <CardDescription>
          Connect the wallet you use on Hyperliquid. You sign one approval; your wallet&apos;s own key never leaves it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connected && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/60 px-4 py-3">
            <div className="min-w-0">
              <p className="eyebrow">Trading account · {isTestnet ? 'testnet' : 'mainnet'}</p>
              <p className="font-mono text-sm mt-1 truncate">{address}</p>
            </div>
            <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
              {step === 'disconnecting' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unplug className="w-3.5 h-3.5" />}
              Disconnect
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Button variant={connected ? 'outline' : 'default'} onClick={() => connect('injected')} disabled={busy || !hasInjected} className="h-11">
            {step !== 'idle' && step !== 'disconnecting' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Smartphone className="w-4 h-4" />}
            {connected ? 'Reconnect with this browser' : 'Connect wallet in this browser'}
          </Button>
          <Button variant="outline" onClick={() => connect('walletconnect')} disabled={busy || !walletConnectProjectId} className="h-11">
            <QrCode className="w-4 h-4" />
            WalletConnect (QR code)
          </Button>
        </div>

        {busy && step !== 'disconnecting' && <p className="text-sm text-primary">{STEP_TEXT[step]}</p>}

        <div className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
          {!hasInjected && (
            <p>
              <span className="text-foreground font-medium">On SafePal:</span>{' '}open this site inside the SafePal app&apos;s
              browser (the DApp tab) and the first button will work with no extra setup.
            </p>
          )}
          {!walletConnectProjectId && (
            <p>
              WalletConnect needs a free project ID: set <code className="bg-secondary px-1 rounded">NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</code> in
              Vercel (create one at cloud.reown.com) and redeploy.
            </p>
          )}
          <p className="flex gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-profit" />
            <span>
              What you approve is a separate trading key for this app. It can place and cancel orders on your Hyperliquid
              account but <span className="text-foreground">cannot withdraw or transfer funds</span>. Disconnect here, or revoke it on
              Hyperliquid (More → API), at any time. The wallet must already have deposited to Hyperliquid
              {isTestnet ? ' testnet' : ''}.
            </span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
