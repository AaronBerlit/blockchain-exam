// Minimal deploy for a public testnet:
//   npx hardhat run scripts/deploy.cjs --network sepolia
// Needs SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY (a throwaway TESTNET key) in .env.
// Constructor args come from MIN_STAKE (ETH), SEED_WINDOW (s) and REVEAL_WINDOW (s).
//
// This only deploys the contract. The full demo (staff, papers, commits, reveal)
// runs on a local Hardhat node: npm run node + npm run demo:setup.
const hre = require("hardhat");

async function main() {
  const minStake = hre.ethers.parseEther(process.env.MIN_STAKE || "0.5");
  const seedWindow = BigInt(process.env.SEED_WINDOW || 120);
  const revealWindow = BigInt(process.env.REVEAL_WINDOW || 600);

  const [deployer] = await hre.ethers.getSigners();
  const { chainId } = await hre.ethers.provider.getNetwork();
  console.log(`Network ${hre.network.name} (chain ${chainId}), deployer ${deployer.address}`);
  console.log(`Balance: ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH`);
  console.log(`Args: minStake ${hre.ethers.formatEther(minStake)} ETH, seedWindow ${seedWindow}s, revealWindow ${revealWindow}s`);

  const vault = await hre.ethers.deployContract("ExamVault", [minStake, seedWindow, revealWindow]);
  await vault.waitForDeployment();

  console.log(`ExamVault deployed at:          ${await vault.getAddress()}`);
  console.log(`CollegeAccessToken deployed at: ${await vault.accessToken()}`);
  console.log("Next: register staff/colleges and call setExam from the admin wallet.");
  console.log("Note: the full scripted demo is local only (npm run node + npm run demo:setup).");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
