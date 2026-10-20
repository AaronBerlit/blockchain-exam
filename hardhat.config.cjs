// Keep Hardhat's global folders (solc compiler downloads, telemetry consent) on D:.
// Hardhat 2 resolves them via env-paths, which reads these variables on Windows.
// The npm scripts already set them through scripts/d-env.cjs; this is a safety net
// for a bare `npx hardhat ...` (compiler downloads happen after the config loads).
const path = require("path");
const D_CACHE = "D:/blockchain-exam-cache";
process.env.LOCALAPPDATA = path.win32.normalize(`${D_CACHE}/localappdata`);
process.env.APPDATA = path.win32.normalize(`${D_CACHE}/appdata`);
process.env.HARDHAT_DISABLE_TELEMETRY_PROMPT = "true";

require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ quiet: true });

const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    ...(SEPOLIA_RPC_URL && DEPLOYER_PRIVATE_KEY
      ? { sepolia: { url: SEPOLIA_RPC_URL, accounts: [DEPLOYER_PRIVATE_KEY], chainId: 11155111 } }
      : {}),
  },
};
