/** Principal entering or leaving the perp account, excluding trading costs. */
export function ledgerCashflow(delta: Record<string, unknown>, address: string): number {
  const amount = Number(delta.usdc ?? 0);
  if (!Number.isFinite(amount)) throw new Error('Invalid cash movement in exchange ledger');
  switch (delta.type) {
    case 'deposit': case 'vaultDistribution': case 'vaultLeaderCommission': return amount;
    case 'withdraw': case 'vaultCreate': case 'vaultDeposit': return -amount;
    case 'internalTransfer': case 'subAccountTransfer':
      return String(delta.destination).toLowerCase() === address.toLowerCase() ? amount : -amount;
    case 'accountClassTransfer': return delta.toPerp === true ? amount : -amount;
    case 'vaultWithdraw': {
      const value = Number(delta.netWithdrawnUsd);
      if (!Number.isFinite(value)) throw new Error('Invalid vault withdrawal in exchange ledger');
      return value;
    }
    case 'liquidation': case 'spotTransfer': case 'spotGenesis': case 'rewardsClaim': return 0;
    default: throw new Error(`Unrecognized exchange ledger movement: ${String(delta.type)}`);
  }
}
