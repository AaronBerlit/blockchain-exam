#!/usr/bin/env node
// Runs a command with every cache/temp/config dir redirected to D: so nothing lands on C:.
// Usage: node scripts/d-env.cjs <command> [args...]
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const dirs = {
  LOCALAPPDATA: "D:\\blockchain-exam-cache\\localappdata",
  APPDATA: "D:\\blockchain-exam-cache\\appdata",
  TEMP: "D:\\temp",
  TMP: "D:\\temp",
  npm_config_cache: "D:\\npm-cache",
  IPFS_PATH: "D:\\ipfs",
  XDG_CACHE_HOME: "D:\\blockchain-exam-cache\\xdg",
};
for (const d of new Set(Object.values(dirs))) fs.mkdirSync(d, { recursive: true });
// `hardhat console` / node REPL history would otherwise go to %USERPROFILE% on C:.
dirs.NODE_REPL_HISTORY = "D:\\blockchain-exam-cache\\node_repl_history";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node scripts/d-env.cjs <command> [args...]");
  process.exit(2);
}

// Join into one command line ourselves (passing args + shell:true is deprecated, DEP0190).
const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const child = spawn([cmd, ...args].map(q).join(" "), {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ...dirs, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
});
child.on("error", (e) => { console.error(e.message); process.exit(1); });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
