// Deploys OnchainTranslator to Ritual Chain and (optionally) funds its
// RitualWallet balance so it can pay for LLM precompile calls.
//
// Usage:
//   PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network ritual
//
// Optional env:
//   FUND_RIT=0.5   amount of RITUAL to deposit into RitualWallet for the
//                  contract (default 0.5). Set to 0 to skip funding.

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance :", hre.ethers.formatEther(balance), "RITUAL");

  const Factory = await hre.ethers.getContractFactory("OnchainTranslator");
  const translator = await Factory.deploy();
  await translator.waitForDeployment();
  const addr = await translator.getAddress();
  console.log("OnchainTranslator deployed at:", addr);

  const fund = process.env.FUND_RIT ?? "0.5";
  if (fund !== "0") {
    const value = hre.ethers.parseEther(fund);
    console.log(`Depositing ${fund} RITUAL into RitualWallet for the contract...`);
    // Lock for 100_000 blocks (~10h at ~350ms) so it survives dev sessions.
    const tx = await translator.depositForFees(100000n, { value });
    await tx.wait();
    console.log("Funded. tx:", tx.hash);
  }

  console.log("\nNext steps:");
  console.log("  1. Put this address in frontend/.env as VITE_TRANSLATOR_ADDRESS");
  console.log("  2. cd frontend && npm install && npm run dev");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
