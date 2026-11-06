import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const BURNER_KEY = "ghostframe:devnet-burner-key";

/**
 * A throwaway devnet wallet for depositing, kept in this browser only. Devnet ETH is worthless and
 * comes from the faucet, so a burner beats asking judges to add a custom network to their wallet.
 */
export function loadBurner(): PrivateKeyAccount {
  let key: string | null = null;
  try {
    key = localStorage.getItem(BURNER_KEY);
  } catch {
    // storage blocked: the burner lives for this page load only
  }
  if (!key) {
    key = generatePrivateKey();
    try {
      localStorage.setItem(BURNER_KEY, key);
    } catch {
      // ignore
    }
  }
  return privateKeyToAccount(key as Hex);
}

/** A brand-new address that has never held anything: the point of the demo is that it needs no gas. */
export function freshAccount(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}
