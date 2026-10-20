// ExamVault + CollegeAccessToken behaviour tests.
// Pieces are random 33-byte blobs here; the real Shamir split is tested elsewhere.
const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const MIN_STAKE = ethers.parseEther("0.5");
const STAKE = ethers.parseEther("1");
const SEED_WINDOW = 120;
const REVEAL_WINDOW = 600;
const EXAM_DELAY = 3600;

const coder = ethers.AbiCoder.defaultAbiCoder();

function seedCommitment(vault, staff, seed) {
  return ethers.keccak256(coder.encode(["address", "address", "uint256"], [vault, staff, seed]));
}

function pieceCommitment(vault, staff, paper, piece) {
  return ethers.keccak256(
    coder.encode(["address", "address", "uint8", "bytes"], [vault, staff, paper, piece])
  );
}

function expectedPaper(seeds) {
  const x = seeds.reduce((acc, s) => acc ^ s, 0n);
  return Number(BigInt(ethers.keccak256(coder.encode(["uint256"], [x]))) % 3n);
}

const randomSeed = () => BigInt(ethers.hexlify(ethers.randomBytes(32)));
const randomPiece = () => ethers.hexlify(ethers.randomBytes(33));

const PAPER_HASHES = [ethers.id("paper A"), ethers.id("paper B"), ethers.id("paper C")];
const PAPER_CIDS = ["bafyA", "bafyB", "bafyC"];

// ------------------------------------------------------------------ fixtures

async function deployFixture() {
  const signers = await ethers.getSigners();
  const [admin] = signers;
  const staff = signers.slice(1, 6);
  const colleges = signers.slice(6, 8);
  const outsider = signers[8];
  const extra = signers[9];

  const Vault = await ethers.getContractFactory("ExamVault");
  const vault = await Vault.deploy(MIN_STAKE, SEED_WINDOW, REVEAL_WINDOW);
  await vault.waitForDeployment();
  const token = await ethers.getContractAt("CollegeAccessToken", await vault.accessToken());
  const vaultAddr = await vault.getAddress();
  return { vault, vaultAddr, token, admin, staff, colleges, outsider, extra };
}

async function registeredFixture() {
  const f = await deployFixture();
  for (const s of f.staff) await f.vault.registerStaff(s.address);
  await f.vault.registerCollege(f.colleges[0].address, "College One");
  await f.vault.registerCollege(f.colleges[1].address, "College Two");
  return f;
}

async function examSetFixture() {
  const f = await registeredFixture();
  const examTime = (await time.latest()) + EXAM_DELAY;
  await f.vault.setExam(examTime, PAPER_HASHES, PAPER_CIDS);
  return { ...f, examTime };
}

// All 5 staff stake 1 ETH and commit pieces + seeds. College 0 gets a token.
async function committedFixture() {
  const f = await examSetFixture();
  const seeds = [];
  const pieces = [];
  for (const s of f.staff) {
    const seed = randomSeed();
    const ps = [randomPiece(), randomPiece(), randomPiece()];
    seeds.push(seed);
    pieces.push(ps);
    const v = f.vault.connect(s);
    await v.stake({ value: STAKE });
    await v.commitPieces(ps.map((p, i) => pieceCommitment(f.vaultAddr, s.address, i, p)));
    await v.commitSeed(seedCommitment(f.vaultAddr, s.address, seed));
  }
  await f.vault.mintAccessToken(f.colleges[0].address);
  return { ...f, seeds, pieces };
}

async function atExamFixture() {
  const f = await committedFixture();
  await time.increaseTo(f.examTime);
  return f;
}

// All 5 seeds revealed, paper selected.
async function selectedFixture() {
  const f = await atExamFixture();
  for (let i = 0; i < 5; i++) await f.vault.connect(f.staff[i]).revealSeed(f.seeds[i]);
  await f.vault.selectPaper();
  const paper = Number(await f.vault.selectedPaper());
  const selectedAt = Number(await f.vault.selectedAt());
  return { ...f, paper, selectedAt };
}

// Staff 0..2 reveal their pieces; staff 3 and 4 do not.
async function unlockedFixture() {
  const f = await selectedFixture();
  for (let i = 0; i < 3; i++) await f.vault.connect(f.staff[i]).revealPiece(f.pieces[i][f.paper]);
  return f;
}

// ===================================================================== tests

describe("ExamVault", function () {
  describe("deployment", function () {
    it("stores config and deploys an access token owned by the vault", async function () {
      const { vault, vaultAddr, token, admin } = await loadFixture(deployFixture);
      expect(await vault.admin()).to.equal(admin.address);
      expect(await vault.minStake()).to.equal(MIN_STAKE);
      expect(await vault.seedWindow()).to.equal(SEED_WINDOW);
      expect(await vault.revealWindow()).to.equal(REVEAL_WINDOW);
      expect(await token.owner()).to.equal(vaultAddr);
      expect(await vault.examTime()).to.equal(0);
    });
  });

  describe("access control & setup", function () {
    it("only admin can register staff and colleges", async function () {
      const { vault, staff, colleges, outsider } = await loadFixture(deployFixture);
      await expect(vault.connect(outsider).registerStaff(staff[0].address)).to.be.revertedWithCustomError(vault, "NotAdmin");
      await expect(vault.connect(outsider).registerCollege(colleges[0].address, "X")).to.be.revertedWithCustomError(vault, "NotAdmin");
    });

    it("registers staff with indexes 1..5 and emits events", async function () {
      const { vault, staff } = await loadFixture(deployFixture);
      for (let i = 0; i < 5; i++) {
        await expect(vault.registerStaff(staff[i].address)).to.emit(vault, "StaffRegistered").withArgs(staff[i].address, i + 1);
      }
      expect(await vault.getStaffList()).to.deep.equal(staff.map((s) => s.address));
      const v = await vault.getStaff(staff[2].address);
      expect(v.registered).to.equal(true);
      expect(v.index).to.equal(3);
    });

    it("registers colleges and emits events", async function () {
      const { vault, colleges } = await loadFixture(deployFixture);
      await expect(vault.registerCollege(colleges[0].address, "College One"))
        .to.emit(vault, "CollegeRegistered").withArgs(colleges[0].address, "College One");
      const c = await vault.getCollege(colleges[0].address);
      expect(c.registered).to.equal(true);
      expect(c.name).to.equal("College One");
      expect(c.tokenId).to.equal(0);
      expect(await vault.getCollegeList()).to.deep.equal([colleges[0].address]);
    });

    it("admin can't be staff (or a college); zero address rejected", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await expect(vault.registerStaff(admin.address)).to.be.revertedWithCustomError(vault, "InvalidAddress");
      await expect(vault.registerStaff(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "InvalidAddress");
      await expect(vault.registerCollege(admin.address, "A")).to.be.revertedWithCustomError(vault, "InvalidAddress");
      await expect(vault.registerCollege(ethers.ZeroAddress, "A")).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });

    it("rejects duplicate registration and staff/college overlap", async function () {
      const { vault, staff, colleges } = await loadFixture(registeredFixture);
      await expect(vault.registerStaff(staff[0].address)).to.be.revertedWithCustomError(vault, "AlreadyRegistered");
      await expect(vault.registerStaff(colleges[0].address)).to.be.revertedWithCustomError(vault, "AlreadyRegistered");
      await expect(vault.registerCollege(colleges[0].address, "again")).to.be.revertedWithCustomError(vault, "AlreadyRegistered");
      await expect(vault.registerCollege(staff[0].address, "staff")).to.be.revertedWithCustomError(vault, "AlreadyRegistered");
    });

    it("allows at most 5 staff", async function () {
      const { vault, extra } = await loadFixture(registeredFixture);
      await expect(vault.registerStaff(extra.address)).to.be.revertedWithCustomError(vault, "TooManyStaff");
    });

    it("setExam needs exactly 5 staff", async function () {
      const { vault, staff } = await loadFixture(deployFixture);
      for (let i = 0; i < 4; i++) await vault.registerStaff(staff[i].address);
      const t = (await time.latest()) + EXAM_DELAY;
      await expect(vault.setExam(t, PAPER_HASHES, PAPER_CIDS)).to.be.revertedWithCustomError(vault, "NotEnoughStaff");
    });

    it("setExam is admin-only", async function () {
      const { vault, outsider } = await loadFixture(registeredFixture);
      const t = (await time.latest()) + EXAM_DELAY;
      await expect(vault.connect(outsider).setExam(t, PAPER_HASHES, PAPER_CIDS)).to.be.revertedWithCustomError(vault, "NotAdmin");
    });

    it("setExam needs a future time", async function () {
      const { vault } = await loadFixture(registeredFixture);
      const now = await time.latest();
      await expect(vault.setExam(now, PAPER_HASHES, PAPER_CIDS)).to.be.revertedWithCustomError(vault, "TimeNotInFuture");
      await expect(vault.setExam(0, PAPER_HASHES, PAPER_CIDS)).to.be.revertedWithCustomError(vault, "TimeNotInFuture");
    });

    it("setExam needs nonzero hashes and nonempty CIDs", async function () {
      const { vault } = await loadFixture(registeredFixture);
      const t = (await time.latest()) + EXAM_DELAY;
      for (let i = 0; i < 3; i++) {
        const hashes = [...PAPER_HASHES];
        hashes[i] = ethers.ZeroHash;
        await expect(vault.setExam(t, hashes, PAPER_CIDS)).to.be.revertedWithCustomError(vault, "InvalidPaper");
        const cids = [...PAPER_CIDS];
        cids[i] = "";
        await expect(vault.setExam(t, PAPER_HASHES, cids)).to.be.revertedWithCustomError(vault, "InvalidPaper");
      }
    });

    it("setExam stores papers, emits ExamSet, and can only run once", async function () {
      const { vault } = await loadFixture(registeredFixture);
      const t = (await time.latest()) + EXAM_DELAY;
      await expect(vault.setExam(t, PAPER_HASHES, PAPER_CIDS)).to.emit(vault, "ExamSet").withArgs(t, PAPER_HASHES, PAPER_CIDS);
      expect(await vault.examTime()).to.equal(t);
      const [hashes, cids] = await vault.getPapers();
      expect(hashes).to.deep.equal(PAPER_HASHES);
      expect(cids).to.deep.equal(PAPER_CIDS);
      await expect(vault.setExam(t + 10, PAPER_HASHES, PAPER_CIDS)).to.be.revertedWithCustomError(vault, "ExamAlreadySet");
    });

    it("registration is closed after setExam", async function () {
      const { vault, outsider } = await loadFixture(examSetFixture);
      await expect(vault.registerStaff(outsider.address)).to.be.revertedWithCustomError(vault, "ExamAlreadySet");
      await expect(vault.registerCollege(outsider.address, "late")).to.be.revertedWithCustomError(vault, "ExamAlreadySet");
    });
  });

  describe("staking", function () {
    it("staff can stake (accumulates) and emits Staked", async function () {
      const { vault, vaultAddr, staff } = await loadFixture(examSetFixture);
      const v = vault.connect(staff[0]);
      await expect(v.stake({ value: MIN_STAKE })).to.emit(vault, "Staked").withArgs(staff[0].address, MIN_STAKE, MIN_STAKE);
      await expect(v.stake({ value: MIN_STAKE })).to.emit(vault, "Staked").withArgs(staff[0].address, MIN_STAKE, MIN_STAKE * 2n);
      expect((await vault.getStaff(staff[0].address)).stake).to.equal(MIN_STAKE * 2n);
      expect(await ethers.provider.getBalance(vaultAddr)).to.equal(MIN_STAKE * 2n);
    });

    it("staking is allowed before setExam", async function () {
      const { vault, staff } = await loadFixture(registeredFixture);
      await expect(vault.connect(staff[0]).stake({ value: STAKE })).to.emit(vault, "Staked");
    });

    it("ZeroDeposit and NotStaff", async function () {
      const { vault, staff, outsider } = await loadFixture(examSetFixture);
      await expect(vault.connect(staff[0]).stake({ value: 0 })).to.be.revertedWithCustomError(vault, "ZeroDeposit");
      await expect(vault.connect(outsider).stake({ value: STAKE })).to.be.revertedWithCustomError(vault, "NotStaff");
    });

    it("no staking after exam time", async function () {
      const { vault, staff, examTime } = await loadFixture(examSetFixture);
      await time.increaseTo(examTime);
      await expect(vault.connect(staff[0]).stake({ value: STAKE })).to.be.revertedWithCustomError(vault, "TooLate");
    });
  });

  describe("commitments", function () {
    it("JS commitments equal the contract's seedCommitment/pieceCommitment views", async function () {
      const { vault, vaultAddr, staff } = await loadFixture(deployFixture);
      const seed = randomSeed();
      const piece = randomPiece();
      expect(await vault.seedCommitment(vaultAddr, staff[0].address, seed)).to.equal(seedCommitment(vaultAddr, staff[0].address, seed));
      for (let p = 0; p < 3; p++) {
        expect(await vault.pieceCommitment(vaultAddr, staff[0].address, p, piece)).to.equal(
          pieceCommitment(vaultAddr, staff[0].address, p, piece)
        );
      }
    });

    it("commit fails before setExam (ExamNotSet)", async function () {
      const { vault, staff } = await loadFixture(registeredFixture);
      const v = vault.connect(staff[0]);
      await v.stake({ value: STAKE });
      await expect(v.commitSeed(ethers.id("x"))).to.be.revertedWithCustomError(vault, "ExamNotSet");
      await expect(v.commitPieces([ethers.id("a"), ethers.id("b"), ethers.id("c")])).to.be.revertedWithCustomError(vault, "ExamNotSet");
    });

    it("commit needs stake >= minStake (StakeTooLow)", async function () {
      const { vault, staff } = await loadFixture(examSetFixture);
      const v = vault.connect(staff[0]);
      await expect(v.commitSeed(ethers.id("x"))).to.be.revertedWithCustomError(vault, "StakeTooLow");
      await v.stake({ value: MIN_STAKE - 1n });
      await expect(v.commitSeed(ethers.id("x"))).to.be.revertedWithCustomError(vault, "StakeTooLow");
      await expect(v.commitPieces([ethers.id("a"), ethers.id("b"), ethers.id("c")])).to.be.revertedWithCustomError(vault, "StakeTooLow");
      await v.stake({ value: 1n });
      await expect(v.commitSeed(ethers.id("x"))).to.emit(vault, "SeedCommitted");
    });

    it("only staff can commit", async function () {
      const { vault, outsider } = await loadFixture(examSetFixture);
      await expect(vault.connect(outsider).commitSeed(ethers.id("x"))).to.be.revertedWithCustomError(vault, "NotStaff");
      await expect(vault.connect(outsider).commitPieces([ethers.id("a"), ethers.id("b"), ethers.id("c")])).to.be.revertedWithCustomError(vault, "NotStaff");
    });

    it("commits are stored, emit events and can only be made once", async function () {
      const { vault, vaultAddr, staff } = await loadFixture(examSetFixture);
      const s = staff[0];
      const v = vault.connect(s);
      await v.stake({ value: STAKE });
      const ps = [randomPiece(), randomPiece(), randomPiece()];
      const commits = ps.map((p, i) => pieceCommitment(vaultAddr, s.address, i, p));
      const seedC = seedCommitment(vaultAddr, s.address, randomSeed());
      await expect(v.commitPieces(commits)).to.emit(vault, "PiecesCommitted").withArgs(s.address, commits);
      await expect(v.commitSeed(seedC)).to.emit(vault, "SeedCommitted").withArgs(s.address, seedC);
      expect(await vault.getPieceCommits(s.address)).to.deep.equal(commits);
      expect(await vault.seedsCommitted()).to.equal(1);
      const info = await vault.getStaff(s.address);
      expect(info.piecesCommitted).to.equal(true);
      expect(info.seedCommitted).to.equal(true);
      await expect(v.commitPieces(commits)).to.be.revertedWithCustomError(vault, "AlreadyCommitted");
      await expect(v.commitSeed(seedC)).to.be.revertedWithCustomError(vault, "AlreadyCommitted");
    });

    it("commit only before exam time", async function () {
      const { vault, staff, examTime } = await loadFixture(examSetFixture);
      const v = vault.connect(staff[0]);
      await v.stake({ value: STAKE });
      await time.increaseTo(examTime);
      await expect(v.commitSeed(ethers.id("x"))).to.be.revertedWithCustomError(vault, "TooLate");
      await expect(v.commitPieces([ethers.id("a"), ethers.id("b"), ethers.id("c")])).to.be.revertedWithCustomError(vault, "TooLate");
    });
  });

  describe("seed reveal", function () {
    it("Revealing a seed before exam time fails", async function () {
      const { vault, staff, seeds } = await loadFixture(committedFixture);
      await expect(vault.connect(staff[0]).revealSeed(seeds[0])).to.be.revertedWithCustomError(vault, "TooEarly");
    });

    it("a correct seed is accepted after exam time", async function () {
      const { vault, staff, seeds } = await loadFixture(atExamFixture);
      await expect(vault.connect(staff[0]).revealSeed(seeds[0])).to.emit(vault, "SeedRevealed").withArgs(staff[0].address, seeds[0]);
      expect(await vault.seedsRevealed()).to.equal(1);
      expect((await vault.getStaff(staff[0].address)).seedRevealed).to.equal(true);
    });

    it("a wrong seed is rejected (HashMismatch); another staff's seed can't be replayed", async function () {
      const { vault, staff, seeds } = await loadFixture(atExamFixture);
      await expect(vault.connect(staff[0]).revealSeed(seeds[0] + 1n)).to.be.revertedWithCustomError(vault, "HashMismatch");
      await expect(vault.connect(staff[1]).revealSeed(seeds[0])).to.be.revertedWithCustomError(vault, "HashMismatch");
    });

    it("cannot reveal twice; non-staff and uncommitted staff rejected", async function () {
      const { vault, staff, seeds, outsider } = await loadFixture(atExamFixture);
      await vault.connect(staff[0]).revealSeed(seeds[0]);
      await expect(vault.connect(staff[0]).revealSeed(seeds[0])).to.be.revertedWithCustomError(vault, "AlreadyRevealed");
      await expect(vault.connect(outsider).revealSeed(1n)).to.be.revertedWithCustomError(vault, "NotStaff");
    });

    it("staff who never committed a seed gets NotCommitted", async function () {
      const { vault, staff, examTime } = await loadFixture(examSetFixture);
      await time.increaseTo(examTime);
      await expect(vault.connect(staff[0]).revealSeed(1n)).to.be.revertedWithCustomError(vault, "NotCommitted");
    });

    it("seed reveal window closes after seedWindow", async function () {
      const { vault, staff, seeds, examTime } = await loadFixture(committedFixture);
      await time.setNextBlockTimestamp(examTime + SEED_WINDOW - 1);
      await expect(vault.connect(staff[0]).revealSeed(seeds[0])).to.emit(vault, "SeedRevealed");
      // next block is examTime + SEED_WINDOW
      await expect(vault.connect(staff[1]).revealSeed(seeds[1])).to.be.revertedWithCustomError(vault, "WindowClosed");
    });

    it("seed reveal closes once the paper is selected (even inside the seed window)", async function () {
      const { vault, vaultAddr, staff, examTime } = await loadFixture(examSetFixture);
      const seeds = [];
      for (let i = 0; i < 5; i++) {
        seeds.push(randomSeed());
        await vault.connect(staff[i]).stake({ value: STAKE });
      }
      // Only staff 0..3 commit a seed, so 4 reveals = "all in".
      for (let i = 0; i < 4; i++) {
        await vault.connect(staff[i]).commitSeed(seedCommitment(vaultAddr, staff[i].address, seeds[i]));
      }
      await time.increaseTo(examTime);
      for (let i = 0; i < 4; i++) await vault.connect(staff[i]).revealSeed(seeds[i]);
      await vault.selectPaper();
      expect(await time.latest()).to.be.lessThan(examTime + SEED_WINDOW);
      await expect(vault.connect(staff[4]).revealSeed(seeds[4])).to.be.revertedWithCustomError(vault, "WindowClosed");
    });
  });

  describe("selectPaper", function () {
    it("fails before exam time", async function () {
      const { vault } = await loadFixture(committedFixture);
      await expect(vault.selectPaper()).to.be.revertedWithCustomError(vault, "TooEarly");
    });

    it("fails before setExam", async function () {
      const { vault } = await loadFixture(registeredFixture);
      await expect(vault.selectPaper()).to.be.revertedWithCustomError(vault, "ExamNotSet");
    });

    it("NotEnoughSeeds with fewer than 3 seeds (even after the window)", async function () {
      const { vault, staff, seeds, examTime } = await loadFixture(atExamFixture);
      await expect(vault.selectPaper()).to.be.revertedWithCustomError(vault, "NotEnoughSeeds");
      await vault.connect(staff[0]).revealSeed(seeds[0]);
      await vault.connect(staff[1]).revealSeed(seeds[1]);
      await expect(vault.selectPaper()).to.be.revertedWithCustomError(vault, "NotEnoughSeeds");
      await time.increaseTo(examTime + SEED_WINDOW);
      await expect(vault.selectPaper()).to.be.revertedWithCustomError(vault, "NotEnoughSeeds");
    });

    it("TooEarly when not all seeds are in and the window is still open; ok after the window", async function () {
      const { vault, staff, seeds, examTime } = await loadFixture(atExamFixture);
      for (let i = 0; i < 3; i++) await vault.connect(staff[i]).revealSeed(seeds[i]);
      await expect(vault.selectPaper()).to.be.revertedWithCustomError(vault, "TooEarly");
      await time.setNextBlockTimestamp(examTime + SEED_WINDOW);
      await expect(vault.selectPaper()).to.emit(vault, "PaperSelected").withArgs(expectedPaper(seeds.slice(0, 3)), examTime + SEED_WINDOW);
      expect(await vault.selectedPaper()).to.equal(expectedPaper(seeds.slice(0, 3)));
    });

    it("allowed immediately when all committed seeds are revealed; result = keccak(xor) % 3", async function () {
      const { vault, staff, seeds, examTime } = await loadFixture(atExamFixture);
      for (let i = 0; i < 5; i++) await vault.connect(staff[i]).revealSeed(seeds[i]);
      expect(await time.latest()).to.be.lessThan(examTime + SEED_WINDOW);
      const tx = vault.selectPaper();
      await expect(tx).to.emit(vault, "PaperSelected").withArgs(expectedPaper(seeds), anyValue);
      const paper = Number(await vault.selectedPaper());
      expect(paper).to.be.within(0, 2);
      expect(paper).to.equal(expectedPaper(seeds));
      expect(await vault.paperSelected()).to.equal(true);
      expect(await vault.selectedAt()).to.equal(await time.latest());
    });

    it("allowed immediately when only 3 staff committed seeds and all 3 revealed", async function () {
      const { vault, vaultAddr, staff, examTime } = await loadFixture(examSetFixture);
      const seeds = [];
      for (let i = 0; i < 3; i++) {
        const seed = randomSeed();
        seeds.push(seed);
        await vault.connect(staff[i]).stake({ value: STAKE });
        await vault.connect(staff[i]).commitSeed(seedCommitment(vaultAddr, staff[i].address, seed));
      }
      await time.increaseTo(examTime);
      for (let i = 0; i < 3; i++) await vault.connect(staff[i]).revealSeed(seeds[i]);
      await expect(vault.selectPaper()).to.emit(vault, "PaperSelected");
      expect(await vault.selectedPaper()).to.equal(expectedPaper(seeds));
    });

    it("can only be called once", async function () {
      const { vault } = await loadFixture(selectedFixture);
      await expect(vault.selectPaper()).to.be.revertedWithCustomError(vault, "AlreadySelected");
    });

    it("selection is deterministic over many random seed sets and spans 0..2", async function () {
      // Pure JS check of the formula range; the on-chain equality is asserted above.
      const seen = new Set();
      for (let i = 0; i < 60; i++) {
        const p = expectedPaper([randomSeed(), randomSeed(), randomSeed()]);
        expect(p).to.be.within(0, 2);
        seen.add(p);
      }
      expect(seen.size).to.equal(3);
    });
  });

  describe("piece reveal", function () {
    it("Revealing a piece before exam time fails", async function () {
      const { vault, staff, pieces } = await loadFixture(committedFixture);
      for (let p = 0; p < 3; p++) {
        await expect(vault.connect(staff[0]).revealPiece(pieces[0][p])).to.be.revertedWithCustomError(vault, "NotSelected");
      }
    });

    it("revealing a piece after exam time but before selection fails", async function () {
      const { vault, staff, seeds, pieces } = await loadFixture(atExamFixture);
      await vault.connect(staff[0]).revealSeed(seeds[0]);
      await expect(vault.connect(staff[0]).revealPiece(pieces[0][0])).to.be.revertedWithCustomError(vault, "NotSelected");
    });

    it("A wrong piece is rejected", async function () {
      const { vault, staff } = await loadFixture(selectedFixture);
      await expect(vault.connect(staff[0]).revealPiece(randomPiece())).to.be.revertedWithCustomError(vault, "HashMismatch");
    });

    it("a piece for a non-selected paper is rejected", async function () {
      const { vault, staff, pieces, paper } = await loadFixture(selectedFixture);
      for (let p = 0; p < 3; p++) {
        if (p === paper) continue;
        await expect(vault.connect(staff[0]).revealPiece(pieces[0][p])).to.be.revertedWithCustomError(vault, "HashMismatch");
      }
    });

    it("another staff's piece can't be replayed", async function () {
      const { vault, staff, pieces, paper } = await loadFixture(selectedFixture);
      await vault.connect(staff[0]).revealPiece(pieces[0][paper]);
      // staff[1] copies staff[0]'s now-public piece
      await expect(vault.connect(staff[1]).revealPiece(pieces[0][paper])).to.be.revertedWithCustomError(vault, "HashMismatch");
    });

    it("cannot reveal twice; non-staff rejected; uncommitted staff rejected", async function () {
      const { vault, staff, pieces, paper, outsider } = await loadFixture(selectedFixture);
      await vault.connect(staff[0]).revealPiece(pieces[0][paper]);
      await expect(vault.connect(staff[0]).revealPiece(pieces[0][paper])).to.be.revertedWithCustomError(vault, "AlreadyRevealed");
      await expect(vault.connect(outsider).revealPiece(pieces[0][paper])).to.be.revertedWithCustomError(vault, "NotStaff");
    });

    it("staff who never committed pieces gets NotCommitted", async function () {
      const { vault, vaultAddr, staff, examTime } = await loadFixture(examSetFixture);
      const seeds = [];
      for (let i = 0; i < 3; i++) {
        seeds.push(randomSeed());
        await vault.connect(staff[i]).stake({ value: STAKE });
        await vault.connect(staff[i]).commitSeed(seedCommitment(vaultAddr, staff[i].address, seeds[i]));
      }
      await time.increaseTo(examTime);
      for (let i = 0; i < 3; i++) await vault.connect(staff[i]).revealSeed(seeds[i]);
      await vault.selectPaper();
      await expect(vault.connect(staff[0]).revealPiece(randomPiece())).to.be.revertedWithCustomError(vault, "NotCommitted");
    });

    it("3 valid pieces unlock the paper", async function () {
      const { vault, staff, pieces, paper } = await loadFixture(selectedFixture);
      // Reveal out of order to check getRevealedPieces returns staff order.
      const order = [2, 0, 4];
      for (let k = 0; k < 2; k++) {
        const i = order[k];
        await expect(vault.connect(staff[i]).revealPiece(pieces[i][paper]))
          .to.emit(vault, "PieceRevealed").withArgs(staff[i].address, paper, pieces[i][paper])
          .and.not.to.emit(vault, "PaperUnlocked");
        expect(await vault.isUnlocked()).to.equal(false);
      }
      const third = vault.connect(staff[4]).revealPiece(pieces[4][paper]);
      await expect(third).to.emit(vault, "PaperUnlocked").withArgs(paper, anyValue);
      expect(await vault.isUnlocked()).to.equal(true);
      expect(await vault.piecesRevealed()).to.equal(3);

      const [who, revealed] = await vault.getRevealedPieces();
      expect(who).to.deep.equal([staff[0].address, staff[2].address, staff[4].address]);
      expect(revealed).to.deep.equal([pieces[0][paper], pieces[2][paper], pieces[4][paper]]);

      // A 4th piece is still accepted but does not re-emit PaperUnlocked.
      await expect(vault.connect(staff[1]).revealPiece(pieces[1][paper])).to.not.emit(vault, "PaperUnlocked");
      expect((await vault.getRevealedPieces())[0]).to.have.length(4);
    });

    it("reveal window closes after revealWindow", async function () {
      const { vault, staff, pieces, paper, selectedAt } = await loadFixture(selectedFixture);
      await time.setNextBlockTimestamp(selectedAt + REVEAL_WINDOW - 1);
      await expect(vault.connect(staff[0]).revealPiece(pieces[0][paper])).to.emit(vault, "PieceRevealed");
      // next block is selectedAt + REVEAL_WINDOW
      await expect(vault.connect(staff[1]).revealPiece(pieces[1][paper])).to.be.revertedWithCustomError(vault, "WindowClosed");
    });
  });

  describe("colleges & downloads", function () {
    it("A college without a token cannot download", async function () {
      const { vault, colleges, outsider, staff } = await loadFixture(unlockedFixture);
      await expect(vault.connect(colleges[1]).logDownload()).to.be.revertedWithCustomError(vault, "NoToken");
      await expect(vault.connect(outsider).logDownload()).to.be.revertedWithCustomError(vault, "NoToken");
      await expect(vault.connect(staff[0]).logDownload()).to.be.revertedWithCustomError(vault, "NoToken");
    });

    it("a token holder can't download before unlock (PaperLocked)", async function () {
      const { vault, colleges, staff, pieces, paper } = await loadFixture(selectedFixture);
      await expect(vault.connect(colleges[0]).logDownload()).to.be.revertedWithCustomError(vault, "PaperLocked");
      await vault.connect(staff[0]).revealPiece(pieces[0][paper]);
      await vault.connect(staff[1]).revealPiece(pieces[1][paper]);
      await expect(vault.connect(colleges[0]).logDownload()).to.be.revertedWithCustomError(vault, "PaperLocked");
    });

    it("a token holder can't download before the exam either", async function () {
      const { vault, colleges } = await loadFixture(committedFixture);
      await expect(vault.connect(colleges[0]).logDownload()).to.be.revertedWithCustomError(vault, "PaperLocked");
    });

    it("a token holder can download after unlock; downloads are recorded with time", async function () {
      const { vault, colleges } = await loadFixture(unlockedFixture);
      const tokenId = (await vault.getCollege(colleges[0].address)).tokenId;
      expect(tokenId).to.equal(1);
      const t1 = (await time.latest()) + 5;
      await time.setNextBlockTimestamp(t1);
      await expect(vault.connect(colleges[0]).logDownload()).to.emit(vault, "Downloaded").withArgs(colleges[0].address, tokenId, t1);
      await vault.connect(colleges[0]).logDownload();
      const t2 = await time.latest();
      const d = await vault.getDownloads();
      expect(d).to.have.length(2);
      expect(d[0].college).to.equal(colleges[0].address);
      expect(d[0].tokenId).to.equal(tokenId);
      expect(d[0].time).to.equal(t1);
      expect(d[1].time).to.equal(t2);
    });
  });

  describe("soulbound access token", function () {
    it("mintAccessToken only admin, only registered college, only once", async function () {
      const { vault, token, colleges, staff, outsider } = await loadFixture(registeredFixture);
      await expect(vault.connect(outsider).mintAccessToken(colleges[0].address)).to.be.revertedWithCustomError(vault, "NotAdmin");
      await expect(vault.mintAccessToken(outsider.address)).to.be.revertedWithCustomError(vault, "NotCollege");
      await expect(vault.mintAccessToken(staff[0].address)).to.be.revertedWithCustomError(vault, "NotCollege");
      await expect(vault.mintAccessToken(colleges[0].address))
        .to.emit(vault, "AccessTokenMinted").withArgs(colleges[0].address, 1)
        .and.to.emit(token, "Locked").withArgs(1);
      await expect(vault.mintAccessToken(colleges[0].address)).to.be.revertedWithCustomError(vault, "HasToken");
      expect(await token.ownerOf(1)).to.equal(colleges[0].address);
      expect(await token.balanceOf(colleges[0].address)).to.equal(1);
      await expect(vault.mintAccessToken(colleges[1].address)).to.emit(vault, "AccessTokenMinted").withArgs(colleges[1].address, 2);
      expect(await token.totalMinted()).to.equal(2);
    });

    it("minting is allowed after setExam too", async function () {
      const { vault, colleges } = await loadFixture(examSetFixture);
      await expect(vault.mintAccessToken(colleges[1].address)).to.emit(vault, "AccessTokenMinted");
    });

    it("only the vault can mint on the token directly", async function () {
      const { token, admin, outsider } = await loadFixture(deployFixture);
      await expect(token.connect(admin).mint(outsider.address)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });

    it("transferFrom / safeTransferFrom / approve / setApprovalForAll all revert (Soulbound)", async function () {
      const { token, colleges, outsider } = await loadFixture(committedFixture);
      const c = colleges[0];
      const t = token.connect(c);
      await expect(t.transferFrom(c.address, outsider.address, 1)).to.be.revertedWithCustomError(token, "Soulbound");
      await expect(t["safeTransferFrom(address,address,uint256)"](c.address, outsider.address, 1)).to.be.revertedWithCustomError(token, "Soulbound");
      await expect(t["safeTransferFrom(address,address,uint256,bytes)"](c.address, outsider.address, 1, "0x")).to.be.revertedWithCustomError(token, "Soulbound");
      await expect(t.approve(outsider.address, 1)).to.be.revertedWithCustomError(token, "Soulbound");
      await expect(t.setApprovalForAll(outsider.address, true)).to.be.revertedWithCustomError(token, "Soulbound");
      expect(await token.ownerOf(1)).to.equal(c.address);
    });

    it("locked() is true; supportsInterface(ERC-5192 0xb45a3c0e) is true", async function () {
      const { token } = await loadFixture(committedFixture);
      expect(await token.locked(1)).to.equal(true);
      await expect(token.locked(99)).to.be.revertedWithCustomError(token, "ERC721NonexistentToken");
      expect(await token.supportsInterface("0xb45a3c0e")).to.equal(true);
      expect(await token.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
      expect(await token.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC-165
      expect(await token.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  describe("penalties & stake withdrawal", function () {
    // In unlockedFixture staff 0..2 revealed both duties; staff 3 and 4 skipped their piece.
    async function dutiesOverFixture() {
      const f = await unlockedFixture();
      await time.increaseTo(f.selectedAt + REVEAL_WINDOW);
      return f;
    }

    it("A staff member who misses the window loses part of their deposit", async function () {
      const { vault, staff } = await loadFixture(dutiesOverFixture);
      expect(await vault.dutiesOver()).to.equal(true);
      expect(await vault.missedDuty(staff[3].address)).to.equal(true);
      const half = STAKE / 2n;
      await expect(vault.connect(staff[0]).penalise(staff[3].address)).to.emit(vault, "Penalised").withArgs(staff[3].address, half);
      const info = await vault.getStaff(staff[3].address);
      expect(info.stake).to.equal(half);
      expect(info.penalised).to.equal(true);
      expect(await vault.slashedTotal()).to.equal(half);
    });

    it("can't penalise twice", async function () {
      const { vault, staff, outsider } = await loadFixture(dutiesOverFixture);
      await vault.connect(outsider).penalise(staff[3].address);
      await expect(vault.connect(outsider).penalise(staff[3].address)).to.be.revertedWithCustomError(vault, "NothingToPenalise");
    });

    it("can't penalise an honest staff member", async function () {
      const { vault, staff } = await loadFixture(dutiesOverFixture);
      expect(await vault.missedDuty(staff[0].address)).to.equal(false);
      await expect(vault.penalise(staff[0].address)).to.be.revertedWithCustomError(vault, "NothingToPenalise");
    });

    it("can't penalise a non-staff address", async function () {
      const { vault, outsider } = await loadFixture(dutiesOverFixture);
      await expect(vault.penalise(outsider.address)).to.be.revertedWithCustomError(vault, "NotStaff");
    });

    it("can't penalise before dutiesOver", async function () {
      const { vault, staff, selectedAt } = await loadFixture(unlockedFixture);
      expect(await vault.dutiesOver()).to.equal(false);
      await expect(vault.penalise(staff[3].address)).to.be.revertedWithCustomError(vault, "DutiesNotOver");
      await time.setNextBlockTimestamp(selectedAt + REVEAL_WINDOW - 1);
      await expect(vault.penalise(staff[3].address)).to.be.revertedWithCustomError(vault, "DutiesNotOver");
    });

    it("a staff member who missed the seed reveal is penalisable", async function () {
      const { vault, staff, seeds, pieces, examTime } = await loadFixture(atExamFixture);
      for (let i = 0; i < 4; i++) await vault.connect(staff[i]).revealSeed(seeds[i]);
      await time.increaseTo(examTime + SEED_WINDOW);
      await vault.selectPaper();
      const paper = Number(await vault.selectedPaper());
      // staff[4] revealed no seed but can still reveal a piece; still missed a duty.
      for (let i = 0; i < 5; i++) await vault.connect(staff[i]).revealPiece(pieces[i][paper]);
      await time.increaseTo(Number(await vault.selectedAt()) + REVEAL_WINDOW);
      expect(await vault.missedDuty(staff[4].address)).to.equal(true);
      await expect(vault.penalise(staff[4].address)).to.emit(vault, "Penalised").withArgs(staff[4].address, STAKE / 2n);
      await expect(vault.penalise(staff[0].address)).to.be.revertedWithCustomError(vault, "NothingToPenalise");
    });

    it("withdrawStake pays honest staff in full", async function () {
      const { vault, vaultAddr, staff } = await loadFixture(dutiesOverFixture);
      await expect(vault.connect(staff[0]).withdrawStake())
        .to.changeEtherBalances([staff[0], vaultAddr], [STAKE, -STAKE]);
      const info = await vault.getStaff(staff[0].address);
      expect(info.withdrawn).to.equal(true);
      expect(info.stake).to.equal(0);
    });

    it("withdrawStake emits StakeWithdrawn and can't be repeated", async function () {
      const { vault, staff } = await loadFixture(dutiesOverFixture);
      await expect(vault.connect(staff[1]).withdrawStake()).to.emit(vault, "StakeWithdrawn").withArgs(staff[1].address, STAKE);
      await expect(vault.connect(staff[1]).withdrawStake()).to.be.revertedWithCustomError(vault, "AlreadyWithdrawn");
    });

    it("withdrawStake auto-slashes an unpenalised offender", async function () {
      const { vault, vaultAddr, staff } = await loadFixture(dutiesOverFixture);
      const half = STAKE / 2n;
      const tx = vault.connect(staff[4]).withdrawStake();
      await expect(tx).to.changeEtherBalances([staff[4], vaultAddr], [half, -half]);
      await expect(tx).to.emit(vault, "Penalised").withArgs(staff[4].address, half);
      await expect(tx).to.emit(vault, "StakeWithdrawn").withArgs(staff[4].address, half);
      expect(await vault.slashedTotal()).to.equal(half);
      // Cannot be penalised again afterwards.
      await expect(vault.penalise(staff[4].address)).to.be.revertedWithCustomError(vault, "NothingToPenalise");
    });

    it("an already-penalised offender withdraws the remaining half without a second slash", async function () {
      const { vault, staff } = await loadFixture(dutiesOverFixture);
      await vault.penalise(staff[3].address);
      const half = STAKE / 2n;
      const tx = vault.connect(staff[3]).withdrawStake();
      await expect(tx).to.changeEtherBalance(staff[3], half);
      await expect(tx).to.not.emit(vault, "Penalised");
      expect(await vault.slashedTotal()).to.equal(half);
    });

    it("withdrawStake is blocked before dutiesOver and for non-staff", async function () {
      const { vault, staff, outsider } = await loadFixture(unlockedFixture);
      await expect(vault.connect(staff[0]).withdrawStake()).to.be.revertedWithCustomError(vault, "DutiesNotOver");
      await expect(vault.connect(outsider).withdrawStake()).to.be.revertedWithCustomError(vault, "NotStaff");
    });

    it("slashed funds stay locked in the vault after everyone withdraws", async function () {
      const { vault, vaultAddr, staff } = await loadFixture(dutiesOverFixture);
      for (const s of staff) await vault.connect(s).withdrawStake();
      expect(await vault.slashedTotal()).to.equal(STAKE); // two offenders x 0.5 ETH
      expect(await ethers.provider.getBalance(vaultAddr)).to.equal(STAKE);
    });
  });

  describe("postpone", function () {
    it("postpones when fewer than 3 seeds after seedWindow", async function () {
      const { vault, staff, seeds, examTime } = await loadFixture(atExamFixture);
      await vault.connect(staff[0]).revealSeed(seeds[0]);
      await vault.connect(staff[1]).revealSeed(seeds[1]);
      await expect(vault.postpone()).to.be.revertedWithCustomError(vault, "DutiesNotOver");
      await time.increaseTo(examTime + SEED_WINDOW);
      expect(await vault.dutiesOver()).to.equal(true);
      await expect(vault.postpone()).to.emit(vault, "ExamPostponed").withArgs("Fewer than 3 seeds revealed in time", anyValue);
      expect(await vault.postponed()).to.equal(true);
      await expect(vault.connect(staff[2]).revealSeed(seeds[2])).to.be.revertedWithCustomError(vault, "ExamPostponedErr");
      await expect(vault.selectPaper()).to.be.revertedWithCustomError(vault, "ExamPostponedErr");
      await expect(vault.connect(staff[0]).revealPiece(randomPiece())).to.be.revertedWithCustomError(vault, "ExamPostponedErr");
      await expect(vault.postpone()).to.be.revertedWithCustomError(vault, "ExamPostponedErr");
      // Staff who did not reveal a seed are penalisable; revealers are not.
      await expect(vault.penalise(staff[2].address)).to.emit(vault, "Penalised");
      await expect(vault.penalise(staff[0].address)).to.be.revertedWithCustomError(vault, "NothingToPenalise");
    });

    it("postpones when fewer than 3 pieces after revealWindow", async function () {
      const { vault, staff, pieces, paper, selectedAt } = await loadFixture(selectedFixture);
      await vault.connect(staff[0]).revealPiece(pieces[0][paper]);
      await vault.connect(staff[1]).revealPiece(pieces[1][paper]);
      await expect(vault.postpone()).to.be.revertedWithCustomError(vault, "DutiesNotOver");
      await time.increaseTo(selectedAt + REVEAL_WINDOW);
      await expect(vault.postpone()).to.emit(vault, "ExamPostponed").withArgs("Fewer than 3 key pieces revealed in time", anyValue);
      await expect(vault.connect(staff[2]).revealPiece(pieces[2][paper])).to.be.revertedWithCustomError(vault, "ExamPostponedErr");
      expect(await vault.isUnlocked()).to.equal(false);
    });

    it("cannot postpone an unlocked exam", async function () {
      const { vault, selectedAt } = await loadFixture(unlockedFixture);
      await expect(vault.postpone()).to.be.revertedWithCustomError(vault, "DutiesNotOver");
      await time.increaseTo(selectedAt + REVEAL_WINDOW);
      await expect(vault.postpone()).to.be.revertedWithCustomError(vault, "DutiesNotOver");
    });

    it("cannot postpone before setExam or while 3+ seeds are in but unselected", async function () {
      const { vault, staff, seeds, examTime } = await loadFixture(atExamFixture);
      for (let i = 0; i < 3; i++) await vault.connect(staff[i]).revealSeed(seeds[i]);
      await time.increaseTo(examTime + SEED_WINDOW);
      await expect(vault.postpone()).to.be.revertedWithCustomError(vault, "DutiesNotOver");
      const fresh = await loadFixture(registeredFixture);
      await expect(fresh.vault.postpone()).to.be.revertedWithCustomError(fresh.vault, "ExamNotSet");
    });
  });
});
