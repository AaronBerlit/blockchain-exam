// Off-chain crypto: AES envelope, Shamir 3-of-5, hashes, commitments vs. the contract,
// and the prepare-papers / verify-hash scripts.
const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { ethers } = require("hardhat");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = "D:\\temp"; // keep everything off C:
const PAPER_B = path.join(ROOT, "papers", "paper-B.md");

function combos(n, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) return out.push(acc.slice());
    for (let i = start; i < n; i++) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  return out;
}

describe("vaultCrypto (off-chain crypto)", function () {
  let vc, prep, tmp;
  const enc = new TextEncoder();

  before(async function () {
    vc = await import(pathToFileURL(path.join(ROOT, "shared", "vaultCrypto.mjs")).href);
    prep = await import(pathToFileURL(path.join(ROOT, "scripts", "prepare-papers.mjs")).href);
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    tmp = fs.mkdtempSync(path.join(TEMP_ROOT, "exv-test-"));
  });

  after(function () {
    if (tmp && tmp.startsWith(TEMP_ROOT)) fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("AES-256-GCM envelope", function () {
    it("round-trips bytes and the file name", async function () {
      const key = await vc.generateKey();
      expect(key).to.be.instanceOf(Uint8Array);
      expect(key.length).to.equal(32);
      const plain = enc.encode("# Paper\nQ1. Explain hashing. (10)\n");
      const box = await vc.encryptPaper(plain, "paper-Ä.md", key);
      expect(new TextDecoder().decode(box.subarray(0, 4))).to.equal("EXV1");
      const out = await vc.decryptPaper(box, key);
      expect(out.fileName).to.equal("paper-Ä.md");
      expect(Buffer.from(out.bytes).equals(Buffer.from(plain))).to.equal(true);
    });

    it("uses a fresh IV each time", async function () {
      const key = await vc.generateKey();
      const a = await vc.encryptPaper(enc.encode("x"), "a", key);
      const b = await vc.encryptPaper(enc.encode("x"), "a", key);
      expect(vc.toHex(a)).to.not.equal(vc.toHex(b));
    });

    it("fails with the wrong key", async function () {
      const box = await vc.encryptPaper(enc.encode("secret"), "a.md", await vc.generateKey());
      let err;
      try {
        await vc.decryptPaper(box, await vc.generateKey());
      } catch (e) {
        err = e;
      }
      expect(err, "should throw").to.be.instanceOf(Error);
      expect(err.message).to.match(/wrong key|modified/i);
    });

    it("fails when one ciphertext byte is flipped", async function () {
      const key = await vc.generateKey();
      const box = await vc.encryptPaper(enc.encode("secret paper"), "a.md", key);
      for (const pos of [4, 20, box.length - 1]) { // IV, body, tag
        const bad = box.slice();
        bad[pos] ^= 0x01;
        let err;
        try {
          await vc.decryptPaper(bad, key);
        } catch (e) {
          err = e;
        }
        expect(err, `flip at ${pos}`).to.be.instanceOf(Error);
      }
    });

    it("rejects data without the EXV1 header", async function () {
      const key = await vc.generateKey();
      const box = await vc.encryptPaper(enc.encode("x"), "a", key);
      box[0] = 0x00;
      let err;
      try {
        await vc.decryptPaper(box, key);
      } catch (e) {
        err = e;
      }
      expect(err.message).to.match(/EXV1/);
    });
  });

  describe("Shamir 3-of-5", function () {
    it("any 3 of 5 shares rebuild the key and decrypt (all 10 combinations)", async function () {
      const key = await vc.generateKey();
      const plain = enc.encode("Paper body");
      const box = await vc.encryptPaper(plain, "p.md", key);
      const shares = await vc.splitKey(key);
      expect(shares).to.have.length(5);
      const all = combos(5, 3);
      expect(all).to.have.length(10);
      for (const c of all) {
        // also accept hex shares, as read back from staff files / the chain
        const rebuilt = await vc.combineKey(c.map((i) => vc.toHex(shares[i])));
        expect(vc.toHex(rebuilt), `combo ${c}`).to.equal(vc.toHex(key));
        const out = await vc.decryptPaper(box, rebuilt);
        expect(Buffer.from(out.bytes).equals(Buffer.from(plain))).to.equal(true);
      }
    });

    it("2 shares do not give the key", async function () {
      const key = await vc.generateKey();
      const shares = await vc.splitKey(key, 5, 3);
      for (const c of combos(5, 2)) {
        const guess = await vc.combineKey(c.map((i) => shares[i]));
        expect(vc.toHex(guess), `combo ${c}`).to.not.equal(vc.toHex(key));
      }
    });
  });

  describe("hash check (PRD: passes on the original paper, fails on an edited copy)", function () {
    let origFile, editedFile, hash;

    before(async function () {
      const box = await vc.encryptPaper(fs.readFileSync(PAPER_B), "paper-B.md", await vc.generateKey());
      hash = vc.paperHash(box);
      const edited = box.slice();
      edited[edited.length - 5] ^= 0xff;
      origFile = path.join(tmp, "paper-B.enc");
      editedFile = path.join(tmp, "paper-B-edited.enc");
      fs.writeFileSync(origFile, box);
      fs.writeFileSync(editedFile, edited);
    });

    it("paperHash matches the original and differs for the edited copy", function () {
      expect(hash).to.match(/^0x[0-9a-f]{64}$/);
      expect(vc.paperHash(new Uint8Array(fs.readFileSync(origFile)))).to.equal(hash);
      expect(vc.paperHash(new Uint8Array(fs.readFileSync(editedFile)))).to.not.equal(hash);
      expect(hash).to.equal(ethers.keccak256(fs.readFileSync(origFile)));
    });

    it("scripts/verify-hash.mjs exits 0 on the original, 1 on the edited copy", function () {
      const run = (f) =>
        spawnSync(process.execPath, [path.join(ROOT, "scripts", "verify-hash.mjs"), f, hash], { cwd: ROOT, encoding: "utf8" });
      const ok = run(origFile);
      expect(ok.status, ok.stderr).to.equal(0);
      expect(ok.stdout).to.match(/PASS/);
      const bad = run(editedFile);
      expect(bad.status, bad.stderr).to.equal(1);
      expect(bad.stdout).to.match(/FAIL/);
    });
  });

  describe("commitments match ExamVault", function () {
    let vault, staff;

    before(async function () {
      [, staff] = await ethers.getSigners();
      const F = await ethers.getContractFactory("ExamVault");
      vault = await F.deploy(ethers.parseEther("0.01"), 3600, 3600);
      await vault.waitForDeployment();
    });

    it("seedCommitment", async function () {
      const v = await vault.getAddress();
      for (const seed of [0n, 1n, vc.randomSeed(), 2n ** 256n - 1n]) {
        expect(vc.seedCommitment(v, staff.address, seed)).to.equal(await vault.seedCommitment(v, staff.address, seed));
      }
      // lower-case addresses are fine too
      const s = vc.randomSeed();
      expect(vc.seedCommitment(v.toLowerCase(), staff.address.toLowerCase(), s)).to.equal(await vault.seedCommitment(v, staff.address, s));
    });

    it("pieceCommitment (bytes and hex input)", async function () {
      const v = await vault.getAddress();
      const shares = await vc.splitKey(await vc.generateKey());
      for (let paper = 0; paper < 3; paper++) {
        const piece = shares[paper];
        const onChain = await vault.pieceCommitment(v, staff.address, paper, piece);
        expect(vc.pieceCommitment(v, staff.address, paper, piece)).to.equal(onChain);
        expect(vc.pieceCommitment(v, staff.address, paper, vc.toHex(piece))).to.equal(onChain);
      }
    });

    it("randomSeed is a uint256", function () {
      const s = vc.randomSeed();
      expect(typeof s).to.equal("bigint");
      expect(s >= 0n && s < 2n ** 256n).to.equal(true);
    });
  });

  describe("cidForBytes", function () {
    it("gives a CIDv1 raw/sha256 base32 string, stable per content", async function () {
      const a = await vc.cidForBytes(enc.encode("hello"));
      expect(a).to.match(/^bafkrei[a-z2-7]+$/);
      expect(await vc.cidForBytes(enc.encode("hello"))).to.equal(a);
      expect(await vc.cidForBytes(enc.encode("hello!"))).to.not.equal(a);
      // known value: `ipfs add --cid-version=1 --raw-leaves` of "hello"
      expect(a).to.equal("bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
    });
  });

  describe("scripts/prepare-papers.mjs (local mode)", function () {
    let result, outDir, ipfsDir;
    const addrs = Array.from({ length: 5 }, () => ethers.Wallet.createRandom().address);

    before(async function () {
      outDir = path.join(tmp, "out");
      ipfsDir = path.join(tmp, "ipfs");
      result = await prep.preparePapers({ outDir, ipfs: "local", ipfsDir, staffAddresses: addrs, quiet: true });
    });

    it("writes papers.json and 5 staff files", function () {
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "papers.json"), "utf8"));
      expect(manifest.version).to.equal(1);
      expect(manifest.ipfs).to.equal("local");
      expect(manifest.gateway).to.equal(process.env.IPFS_GATEWAY ?? "/ipfs");
      expect(manifest.papers.map((p) => p.label)).to.deep.equal(["A", "B", "C"]);
      expect(manifest.papers[1].sourceFile).to.equal("papers/paper-B.md");
      const files = fs.readdirSync(path.join(outDir, "secrets")).sort();
      expect(files).to.deep.equal([1, 2, 3, 4, 5].map((i) => `staff-${i}.json`));
      for (let i = 1; i <= 5; i++) {
        const s = JSON.parse(fs.readFileSync(path.join(outDir, "secrets", `staff-${i}.json`), "utf8"));
        expect(s.version).to.equal(1);
        expect(s.staffIndex).to.equal(i);
        expect(s.staffAddress).to.equal(addrs[i - 1]);
        expect(s.pieces).to.have.length(3);
        for (const p of s.pieces) expect(p).to.match(/^0x[0-9a-f]+$/);
        expect(s.seed).to.match(/^\d+$/);
        expect(BigInt(s.seed) < 2n ** 256n).to.equal(true);
        expect(Object.keys(s).sort()).to.deep.equal(["pieces", "seed", "staffAddress", "staffIndex", "version"]);
      }
      expect(result.papers).to.have.length(3);
      expect(result.secrets).to.have.length(5);
    });

    it("stores 3 ciphertexts whose hashes and CIDs match the manifest", async function () {
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "papers.json"), "utf8"));
      expect(fs.readdirSync(ipfsDir)).to.have.length(3);
      for (const p of manifest.papers) {
        const bytes = new Uint8Array(fs.readFileSync(path.join(ipfsDir, p.cid)));
        expect(vc.paperHash(bytes)).to.equal(p.hash);
        expect(await vc.cidForBytes(bytes)).to.equal(p.cid);
        expect(bytes.length).to.equal(p.size);
      }
    });

    it("shares from staff 1, 3, 5 decrypt paper B back to the original", async function () {
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "papers.json"), "utf8"));
      const pieces = [1, 3, 5].map((i) => JSON.parse(fs.readFileSync(path.join(outDir, "secrets", `staff-${i}.json`), "utf8")).pieces[1]);
      const key = await vc.combineKey(pieces);
      const bytes = new Uint8Array(fs.readFileSync(path.join(ipfsDir, manifest.papers[1].cid)));
      const out = await vc.decryptPaper(bytes, key);
      expect(out.fileName).to.equal("paper-B.md");
      expect(Buffer.from(out.bytes).equals(fs.readFileSync(PAPER_B))).to.equal(true);
    });

    it("never writes the AES keys to disk", function () {
      const dump = [path.join(outDir, "papers.json"), ...[1, 2, 3, 4, 5].map((i) => path.join(outDir, "secrets", `staff-${i}.json`))]
        .map((f) => fs.readFileSync(f, "utf8"))
        .join("\n");
      expect(dump).to.not.match(/"key"/i);
    });
  });
});
