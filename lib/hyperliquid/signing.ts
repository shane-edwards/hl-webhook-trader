// Hyperliquid signing, kept in one place and checked against reference
// signatures from the official SDK in tests/signing.test.ts.
import { ethers } from 'ethers';
import * as msgpack from '@msgpack/msgpack';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// "L1 actions" (orders, cancels, leverage) are signed by the trading key as a
// phantom Agent whose connectionId is the hash of the action.
const L1_DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_ADDRESS } as const;
const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

export interface Signature { r: string; s: string; v: number }

export function actionHash(action: unknown, vaultAddress: string | null, nonce: number): string {
  const packed = msgpack.encode(action);
  const data = new Uint8Array(packed.length + (vaultAddress ? 29 : 9));
  data.set(packed);
  new DataView(data.buffer).setBigUint64(packed.length, BigInt(nonce), false);
  if (vaultAddress) {
    data[packed.length + 8] = 1;
    data.set(ethers.getBytes(vaultAddress), packed.length + 9);
  } else {
    data[packed.length + 8] = 0;
  }
  return ethers.keccak256(data);
}

export async function signL1Action(wallet: ethers.Wallet, action: unknown, nonce: number, isMainnet: boolean): Promise<Signature> {
  const sig = await wallet.signTypedData(L1_DOMAIN, AGENT_TYPES, {
    source: isMainnet ? 'a' : 'b',
    connectionId: actionHash(action, null, nonce),
  });
  const { r, s, v } = ethers.Signature.from(sig);
  return { r, s, v };
}

// ---------------------------------------------------------------------------
// approveAgent: signed by the user's own wallet, once, to authorise a trading
// key that can place orders but cannot withdraw.
// ---------------------------------------------------------------------------

export interface ApproveAgentAction {
  type: 'approveAgent';
  hyperliquidChain: 'Mainnet' | 'Testnet';
  /** Hex chain id of the network the wallet is on when it signs (any chain works). */
  signatureChainId: string;
  agentAddress: string;
  agentName: string;
  nonce: number;
}

const APPROVE_AGENT_TYPES = {
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
};

export function approveAgentTypedData(action: ApproveAgentAction) {
  return {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: parseInt(action.signatureChainId, 16),
      verifyingContract: ZERO_ADDRESS,
    },
    types: APPROVE_AGENT_TYPES,
    primaryType: 'HyperliquidTransaction:ApproveAgent' as const,
    message: {
      hyperliquidChain: action.hyperliquidChain,
      agentAddress: action.agentAddress.toLowerCase(),
      agentName: action.agentName,
      nonce: action.nonce,
    },
  };
}

/** The same payload in the JSON shape wallets expect for eth_signTypedData_v4. */
export function approveAgentWalletPayload(action: ApproveAgentAction) {
  const { domain, types, primaryType, message } = approveAgentTypedData(action);
  return {
    domain,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...types,
    },
    primaryType,
    message,
  };
}

/** Address that produced `signature` over this approveAgent action. */
export function recoverApproveAgentSigner(action: ApproveAgentAction, signature: string): string {
  const { domain, types, message } = approveAgentTypedData(action);
  return ethers.verifyTypedData(domain, types, message, signature);
}
