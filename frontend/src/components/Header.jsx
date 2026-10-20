import { roleOf } from "../lib/chain.js";
import { shortAddr } from "../lib/format.js";
import { demoEnabled, hasMetaMask, useWallet } from "../lib/wallet.jsx";
import { PadlockIcon } from "./Icons.jsx";

const TABS = [
  { route: "home", label: "Home", href: "#/" },
  { route: "staff", label: "Staff", href: "#/staff" },
  { route: "college", label: "College", href: "#/college" },
];

export default function Header({ route, vault }) {
  const wallet = useWallet();

  return (
    <header className="header">
      <a className="logo" href="#/">
        <span className="logo-tile">
          <PadlockIcon size={20} color="#04201A" strokeWidth={2.4} />
        </span>
        <span className="logo-text">ExamVault</span>
      </a>

      <nav className="nav" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.route} href={t.href} className={`nav-item ${route === t.route ? "nav-active" : ""}`}
            aria-current={route === t.route ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>

      <div className="wallet-area">
        {demoEnabled && wallet && (
          <label className="demo-select">
            <span className="sr-only">Demo account</span>
            <select value={wallet.kind === "demo" ? wallet.address : ""}
              onChange={(e) => wallet.selectDemo(e.target.value)}>
              <option value="">Demo account…</option>
              {wallet.demoAccounts.map((a) => (
                <option key={a} value={a}>
                  {roleOf(a, vault)} · {shortAddr(a)}
                </option>
              ))}
            </select>
          </label>
        )}
        {hasMetaMask && wallet?.kind !== "metamask" && (
          <button className="btn btn-ghost btn-sm" onClick={wallet.connectMetaMask}>Connect wallet</button>
        )}
        {wallet?.address ? (
          <span className="wallet-pill" title={wallet.address}>
            <span className={`dot ${wallet.error ? "dot-amber" : ""}`} />
            <span className="wallet-role">{roleOf(wallet.address, vault)}</span>
            <span className="mono">{shortAddr(wallet.address)}</span>
          </span>
        ) : (
          !hasMetaMask && !demoEnabled && <span className="wallet-pill muted">No wallet</span>
        )}
      </div>
      {wallet?.error && <div className="wallet-error">{wallet.error}</div>}
    </header>
  );
}
