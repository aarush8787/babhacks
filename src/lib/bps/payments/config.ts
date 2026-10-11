/**
 * Settlement configuration for the AUSD / x402 payments layer.
 *
 * Reads process.env once per call and returns a discriminated union so every
 * consumer is forced to handle the "we are not wired up to move real money"
 * case explicitly, instead of the module throwing at import time.
 *
 * The private key is NEVER logged, echoed, or included in any returned
 * object -- `getSettlementConfig()` hands back the raw key only inside the
 * `configured` branch, under a field named `privateKey`, for the signer in
 * ausd.ts to consume directly. Nothing in this module calls console.log.
 */

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * AUSD on Base Sepolia, per Agora's published contract-deployments table
 * (https://docs.agora.finance/developer/contract-deployments.md), fetched
 * 2026-10-11:
 *
 *   0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
 *
 * CONFIRMED: this exact address, listed under "Base Sepolia" in that table.
 * NOT CONFIRMED from docs: that AUSD's deployed bytecode actually implements
 * ERC-3009 `transferWithAuthorization`. Agora's "Advanced ERC Features" page
 * explains ERC-3009 gasless transfers in the abstract but never ties that
 * page to AUSD by name in the content we were able to fetch. We ship this
 * default because it is the address Agora itself publishes for this chain,
 * but `BPS_AUSD_ADDRESS` always overrides it, and ausd.ts's EIP-712 call
 * will simply revert on-chain if the deployed contract does not implement
 * `transferWithAuthorization` -- we do not pretend to have verified the
 * bytecode.
 */
const CONFIRMED_BASE_SEPOLIA_AUSD_ADDRESS = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";

export interface SettlementConfigured {
  status: "configured";
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  rpcUrl: string;
  ausdAddress: `0x${string}`;
  facilitatorUrl: string;
  /** Raw hex private key for the settlement signer. Never log this value. */
  privateKey: `0x${string}`;
}

export interface SettlementUnconfigured {
  status: "unconfigured";
  /** Names of the env vars that are missing or invalid. */
  missing: string[];
}

export type SettlementConfig = SettlementConfigured | SettlementUnconfigured;

function normalizePrivateKey(raw: string): `0x${string}` | null {
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value as `0x${string}`;
}

function normalizeAddress(raw: string): `0x${string}` | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as `0x${string}`;
}

/**
 * Read env and resolve the settlement config. Pure function of
 * `process.env` -- call it fresh each time rather than caching, so tests
 * and runtime env changes are both honored.
 */
export function getSettlementConfig(): SettlementConfig {
  const missing: string[] = [];

  const rawKey = process.env.BPS_SETTLEMENT_PRIVATE_KEY;
  const rpcUrl = process.env.BPS_BASE_SEPOLIA_RPC_URL;
  const rawAusdAddress = process.env.BPS_AUSD_ADDRESS ?? CONFIRMED_BASE_SEPOLIA_AUSD_ADDRESS;
  const facilitatorUrl = process.env.BPS_X402_FACILITATOR_URL;

  let privateKey: `0x${string}` | null = null;
  if (!rawKey) {
    missing.push("BPS_SETTLEMENT_PRIVATE_KEY");
  } else {
    privateKey = normalizePrivateKey(rawKey);
    if (!privateKey) missing.push("BPS_SETTLEMENT_PRIVATE_KEY (malformed: expected 32-byte hex)");
  }

  if (!rpcUrl) missing.push("BPS_BASE_SEPOLIA_RPC_URL");

  const ausdAddress = normalizeAddress(rawAusdAddress);
  if (!ausdAddress) missing.push("BPS_AUSD_ADDRESS (malformed: expected 20-byte hex address)");

  if (!facilitatorUrl) missing.push("BPS_X402_FACILITATOR_URL");

  if (missing.length > 0 || !privateKey || !rpcUrl || !ausdAddress || !facilitatorUrl) {
    return { status: "unconfigured", missing };
  }

  return {
    status: "configured",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    rpcUrl,
    ausdAddress,
    facilitatorUrl,
    privateKey,
  };
}
