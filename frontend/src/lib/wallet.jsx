// Wallet handling: MetaMask (window.ethereum) or, on the local Hardhat chain,
// one of the node's unlocked "demo" accounts. Screens read it with useWallet().
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { BrowserProvider } from "ethers";
import { deployment } from "./deployment.js";
import { readProvider } from "./chain.js";

const WalletContext = createContext(null);
const DEMO_KEY = "examvault:demoAccount";

export const hasMetaMask = typeof window !== "undefined" && !!window.ethereum;
/** Demo accounts are offered without MetaMask, or whenever we are on Hardhat (31337). */
export const demoEnabled = !!deployment && (!hasMetaMask || Number(deployment.chainId) === 31337);

const EMPTY = { kind: null, address: null, signer: null, error: null };

function readStored() {
  try {
    return localStorage.getItem(DEMO_KEY);
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    if (value) localStorage.setItem(DEMO_KEY, value);
    else localStorage.removeItem(DEMO_KEY);
  } catch {
    /* storage blocked: the choice just is not remembered */
  }
}

export function WalletProvider({ children }) {
  const [wallet, setWallet] = useState(EMPTY);
  const [demoAccounts, setDemoAccounts] = useState([]);

  // List the node's unlocked accounts (retry until the node is up).
  useEffect(() => {
    if (!demoEnabled) return undefined;
    let alive = true;
    let timer;
    const load = async () => {
      try {
        const signers = await readProvider.listAccounts();
        if (!alive) return;
        const addresses = signers.map((s) => s.address);
        setDemoAccounts(addresses);
        const stored = readStored();
        if (stored && addresses.some((a) => a.toLowerCase() === stored.toLowerCase())) {
          const signer = await readProvider.getSigner(stored);
          if (alive) setWallet((w) => (w.kind ? w : { kind: "demo", address: signer.address, signer, error: null }));
        }
      } catch {
        if (alive) timer = setTimeout(load, 3000);
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const selectDemo = useCallback(async (address) => {
    if (!address) {
      writeStored(null);
      setWallet(EMPTY);
      return;
    }
    const signer = await readProvider.getSigner(address);
    writeStored(signer.address);
    setWallet({ kind: "demo", address: signer.address, signer, error: null });
  }, []);

  const connectMetaMask = useCallback(async () => {
    try {
      const provider = new BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      const wanted = BigInt(deployment.chainId);
      let { chainId } = await provider.getNetwork();
      if (chainId !== wanted) {
        try {
          await provider.send("wallet_switchEthereumChain", [{ chainId: `0x${wanted.toString(16)}` }]);
        } catch {
          /* user said no or chain unknown: report below */
        }
        chainId = (await new BrowserProvider(window.ethereum).getNetwork()).chainId;
      }
      const fresh = new BrowserProvider(window.ethereum);
      const signer = await fresh.getSigner();
      const error = chainId !== wanted ? `Switch MetaMask to chain ${deployment.chainId}` : null;
      writeStored(null);
      setWallet({ kind: "metamask", address: signer.address, signer: error ? null : signer, error });
    } catch (e) {
      setWallet({ ...EMPTY, error: e.shortMessage || e.message });
    }
  }, []);

  // Follow account / network changes made inside MetaMask.
  useEffect(() => {
    if (!hasMetaMask || wallet.kind !== "metamask") return undefined;
    const onChange = () => connectMetaMask();
    window.ethereum.on?.("accountsChanged", onChange);
    window.ethereum.on?.("chainChanged", onChange);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onChange);
      window.ethereum.removeListener?.("chainChanged", onChange);
    };
  }, [wallet.kind, connectMetaMask]);

  const value = { ...wallet, demoAccounts, selectDemo, connectMetaMask };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  return useContext(WalletContext);
}
