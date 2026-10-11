/**
 * Mint testnet AUSD from Agora's faucet contract on Base Sepolia.
 *
 * Agora documents this faucet against Ethereum Sepolia, but the contract is
 * deployed at the same address on Base Sepolia (a CREATE2 multi-chain deploy),
 * which is the network BPS settles on. Verified by eth_getCode on both chains.
 *
 * The only prerequisite is a little Base Sepolia ETH for gas -- roughly 85k gas
 * for this call. The settlement signer itself never needs gas (ERC-3009 is
 * gasless and the x402 facilitator broadcasts), so this is the one and only
 * transaction BPS ever sends directly.
 *
 * Usage: node scripts/faucet-ausd.mjs
 */
import { createWalletClient, createPublicClient, http, formatUnits, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "node:fs";

function loadEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i < 1 || line.trimStart().startsWith("#")) continue;
      const k = line.slice(0, i).trim();
      if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
    }
  } catch {
    /* .env.local is optional when the vars are already exported */
  }
}
loadEnv();

const FAUCET = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C";
const AUSD = process.env.BPS_AUSD_ADDRESS ?? "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const RPC = process.env.BPS_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

const key = process.env.BPS_SETTLEMENT_PRIVATE_KEY;
if (!key) {
  console.error("BPS_SETTLEMENT_PRIVATE_KEY is not set (expected in .env.local).");
  process.exit(1);
}

const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });

const erc20 = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const faucetAbi = [{ name: "requestFunds", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] }];

const balanceOf = () => pub.readContract({ address: AUSD, abi: erc20, functionName: "balanceOf", args: [account.address] });

console.log("wallet      :", account.address);
const gas = await pub.getBalance({ address: account.address });
console.log("gas balance :", formatEther(gas), "ETH");
console.log("AUSD before :", formatUnits(await balanceOf(), 6));

if (gas === 0n) {
  console.error("\nNo Base Sepolia ETH. Fund this address with a little gas, then re-run:");
  console.error("  " + account.address);
  process.exit(2);
}

// Simulate first so a revert surfaces before we spend anything.
const { request } = await pub.simulateContract({
  account, address: FAUCET, abi: faucetAbi, functionName: "requestFunds", args: [account.address],
});
const hash = await wallet.writeContract(request);
console.log("\ntx submitted:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log("status      :", receipt.status);
console.log("explorer    : https://sepolia.basescan.org/tx/" + hash);
console.log("AUSD after  :", formatUnits(await balanceOf(), 6));
