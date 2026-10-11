/**
 * ERC-3009 primitives for AUSD on Base Sepolia.
 *
 * `transferWithAuthorization` is the gasless primitive x402's "exact" EVM
 * scheme is built on (see https://github.com/coinbase/x402,
 * specs/x402-specification-v1.md section 6.1): the payer signs an EIP-712
 * authorization off-chain and never submits a transaction or pays gas; the
 * facilitator (or anyone holding the signature) later calls
 * `transferWithAuthorization` on-chain to actually move the funds.
 *
 * The EIP-712 type layout below is quoted directly from that spec:
 *
 *   TransferWithAuthorization: [
 *     { name: "from", type: "address" },
 *     { name: "to", type: "address" },
 *     { name: "value", type: "uint256" },
 *     { name: "validAfter", type: "uint256" },
 *     { name: "validBefore", type: "uint256" },
 *     { name: "nonce", type: "bytes32" },
 *   ]
 */

import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getSettlementConfig } from "./config";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface TransferAuthorizationInput {
  from: Address;
  to: Address;
  /** Atomic token units, as a decimal string (AUSD is 6-decimal, matching USDC convention). */
  value: string;
  /** Unix seconds. */
  validAfter: string;
  validBefore: string;
  /** 32-byte hex nonce. */
  nonce: Hex;
}

export interface TransferAuthorizationTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: "TransferWithAuthorization";
  message: {
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
  };
}

/**
 * CONFIRMED on-chain against Base Sepolia on 2026-10-11, not assumed.
 *
 * The deployed AUSD contract at 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
 * implements ERC-5267, so it reports its own domain via `eip712Domain()`:
 *
 *   fields            0x0f
 *   name              "Agora Dollar"     <- NOT "AUSD"
 *   version           "1"                <- NOT "2"
 *   chainId           84532
 *   verifyingContract 0xa9012a...22dC
 *   salt              0x00..00
 *
 * Recomputing the domain separator from those values reproduces the
 * contract's own `DOMAIN_SEPARATOR()`:
 *
 *   keccak256(abi.encode(
 *     keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
 *     keccak256("Agora Dollar"), keccak256("1"), 84532, verifyingContract))
 *   == 0x5a85328c8aae02b57a5bc1fb1848cb2fb9ccbdc204c554a4db199b13fed1e8bb
 *
 * The token name is "Agora Dollar" while its ERC-20 `name()` returns "AUSD",
 * which is why the conventional guess was wrong. An earlier revision used
 * "AUSD"/"2" and every signature it produced would have failed EIP-712
 * verification on-chain.
 *
 * ERC-3009 support is likewise confirmed: `authorizationState(address,bytes32)`
 * answers rather than reverting, and `decimals()` returns 6.
 *
 * To re-verify after any redeploy, call `eip712Domain()` on the token.
 */
const AUSD_EIP712_DOMAIN_NAME = "Agora Dollar";
const AUSD_EIP712_DOMAIN_VERSION = "1";

/**
 * Build (but do not sign) the EIP-712 typed-data payload for a
 * `transferWithAuthorization` call against the configured AUSD contract.
 *
 * Throws if settlement is unconfigured -- callers that need the
 * non-throwing contract should check `getSettlementConfig()` first (as
 * settle.ts does).
 */
export function buildTransferAuthorization(
  input: TransferAuthorizationInput,
): TransferAuthorizationTypedData {
  const config = getSettlementConfig();
  if (config.status !== "configured") {
    throw new Error(`AUSD settlement is not configured: missing ${config.missing.join(", ")}`);
  }

  return {
    domain: {
      name: AUSD_EIP712_DOMAIN_NAME,
      version: AUSD_EIP712_DOMAIN_VERSION,
      chainId: config.chainId,
      verifyingContract: config.ausdAddress,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: input.from,
      to: input.to,
      value: BigInt(input.value),
      validAfter: BigInt(input.validAfter),
      validBefore: BigInt(input.validBefore),
      nonce: input.nonce,
    },
  };
}

export interface SignedTransferAuthorization {
  typedData: TransferAuthorizationTypedData;
  signature: Hex;
}

/**
 * Sign a `transferWithAuthorization` payload with the configured
 * settlement account. The account that signs is the payer (`from`) --
 * for BPS's worker-payout flow that is BPS's own escrow/treasury key, not
 * the worker. Signing is pure EIP-712 message signing: it costs no gas and
 * requires no on-chain transaction from the signer.
 */
export async function signTransferAuthorization(
  input: TransferAuthorizationInput,
): Promise<SignedTransferAuthorization> {
  const config = getSettlementConfig();
  if (config.status !== "configured") {
    throw new Error(`AUSD settlement is not configured: missing ${config.missing.join(", ")}`);
  }

  const typedData = buildTransferAuthorization(input);
  const account = privateKeyToAccount(config.privateKey);

  const signature = await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });

  return { typedData, signature };
}

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Read an address's real AUSD balance over the configured Base Sepolia RPC.
 * Never mocked: if config is missing, this throws rather than returning a
 * placeholder number that could be mistaken for a real balance.
 */
export async function readAusdBalance(address: Address): Promise<bigint> {
  const config = getSettlementConfig();
  if (config.status !== "configured") {
    throw new Error(`AUSD settlement is not configured: missing ${config.missing.join(", ")}`);
  }

  const client = createPublicClient({
    transport: http(config.rpcUrl),
  });

  return client.readContract({
    address: config.ausdAddress,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [address],
  });
}
