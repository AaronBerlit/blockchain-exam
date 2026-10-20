import { useEffect, useState } from "react";
import Header from "./components/Header.jsx";
import Notice from "./components/Notice.jsx";
import { deployment } from "./lib/deployment.js";
import { friendlyError, useVaultState } from "./lib/chain.js";
import { WalletProvider } from "./lib/wallet.jsx";
import Home from "./screens/Home.jsx";
import Staff from "./screens/Staff.jsx";
import College from "./screens/College.jsx";

/** Hash routes: #/ -> home, #/staff, #/college */
function routeFromHash() {
  const h = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return h === "staff" || h === "college" ? h : "home";
}

function useRoute() {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function NotDeployed() {
  return (
    <main className="page">
      <div className="card empty-card">
        <h1 className="h1">Vault not deployed yet</h1>
        <p className="muted">
          Start a local chain and deploy the contracts, then reload this page:
        </p>
        <pre className="code">npm run node{"\n"}npm run demo:setup</pre>
      </div>
    </main>
  );
}

function Portal() {
  const route = useRoute();
  const { state, error, refresh } = useVaultState();

  let body;
  if (!state) {
    body = error ? (
      <div className="card empty-card">
        <h1 className="h1">Cannot reach the vault</h1>
        <p className="muted">
          No answer from <span className="mono">{deployment.rpcUrl}</span>. Is the Hardhat node running
          (<span className="mono">npm run node</span>)?
        </p>
        <p className="muted small">{friendlyError(error)}</p>
      </div>
    ) : (
      <div className="card empty-card"><p className="muted">Reading the vault…</p></div>
    );
  } else if (route === "staff") {
    body = <Staff vault={state} refresh={refresh} />;
  } else if (route === "college") {
    body = <College vault={state} refresh={refresh} />;
  } else {
    body = <Home vault={state} />;
  }

  return (
    <>
      <Header route={route} vault={state} />
      <main className="page">
        {state && error && (
          <Notice tone="red">Lost contact with the chain, showing the last known state. {friendlyError(error)}</Notice>
        )}
        {body}
      </main>
      <footer className="footer muted small">
        Vault <span className="mono">{deployment.vault}</span> · chain {deployment.chainId}
        {state ? <> · block {state.blockNumber}</> : null}
      </footer>
    </>
  );
}

export default function App() {
  if (!deployment) return <NotDeployed />;
  return (
    <WalletProvider>
      <Portal />
    </WalletProvider>
  );
}
