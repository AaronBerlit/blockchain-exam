// deployment.json is written by `npm run demo:setup` (repo root). It may not exist
// yet, so load it through import.meta.glob: a missing file just gives an empty object.
const found = import.meta.glob("../deployment.json", { eager: true, import: "default" });

/** The deployment info, or null when the vault has not been deployed yet. */
export const deployment = Object.values(found)[0] ?? null;

/** Base URL for encrypted papers, without a trailing slash (e.g. "/ipfs"). */
export const ipfsGateway = (deployment?.ipfsGateway || "/ipfs").replace(/\/+$/, "");
