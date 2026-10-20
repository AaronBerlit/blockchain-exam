import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The portal imports ../shared/vaultCrypto.mjs (shared with the Node scripts).
// `dedupe` makes the bare imports inside shared/ (ethers, shamir-secret-sharing,
// multiformats) resolve to frontend/node_modules, so the bundle has one copy of each.
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["ethers", "shamir-secret-sharing", "multiformats"],
  },
  server: {
    port: 5173,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  build: {
    target: "es2022", // BigInt literals + top-level features used by ethers
    chunkSizeWarningLimit: 1200,
  },
});
