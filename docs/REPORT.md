# Time-Locked Exam Papers on a Blockchain — Project Report

## 1. Problem

Exam papers leak because the people who store them (admins, printers, exam cells) can open them before the exam. Access control on a normal server only moves the trust to whoever runs the server. The goal is a system where:

- no one can open a paper before exam time, not even an admin;
- anyone can check that the paper was not changed after upload;
- every upload, unlock and download is logged permanently;
- staff who skip their duty lose part of a deposit automatically.

Out of scope: a paper setter leaking the paper before upload, real money / mainnet, mobile apps.

## 2. Design

The system combines **encryption** (keeps the paper secret) with a **smart contract** (enforces when and how the key may be rebuilt, and logs everything).

1. **Setup.** The admin deploys `ExamVault`, registers 5 staff and the colleges, and calls `setExam(time, hashes, cids)` once. The exam time and paper fingerprints are then immutable.
2. **Papers.** The setter encrypts three candidate papers (A, B, C) with AES-256-GCM, each with a fresh random 256-bit key. Ciphertexts go to IPFS; their keccak256 hashes and CIDs go on-chain. Each key is split with Shamir secret sharing into 5 pieces, threshold 3; staff *i* receives piece *i* of every paper, and the key is then discarded.
3. **Stake and commit.** Each staff member stakes test ETH (≥ `minStake`), then commits `keccak256(vault, staff, paper, piece)` for each of their 3 pieces and `keccak256(vault, staff, seed)` for a secret random seed. Commits are only accepted before exam time.
4. **Paper selection.** After exam time staff reveal seeds; the contract checks each against its commitment and XORs them. `selectPaper()` (callable by anyone) sets `paper = keccak256(xor) mod 3`.
5. **Unlock.** Within the reveal window (10 min) staff reveal their piece for the chosen paper only. Each piece is checked against its commitment. After 3 valid pieces `PaperUnlocked` is emitted.
6. **Download.** A college holding a soulbound access token calls `logDownload()` (recorded with time and token id), fetches the ciphertext, checks its hash against the chain, combines the 3 revealed pieces into the key and decrypts — all client-side.
7. **Penalties.** After the windows close, anyone may call `penalise(staff)`; staff who missed their seed or piece reveal lose 50% of their stake. Slashed funds stay locked in the contract.

Components: `contracts/ExamVault.sol`, `contracts/CollegeAccessToken.sol` (ERC-721 + ERC-5192, transfers and approvals revert), `shared/vaultCrypto.mjs` (AES, Shamir, hashes, commitments, CIDs; shared by Node scripts and the browser), `scripts/prepare-papers.mjs`, `scripts/demo-*.mjs`, and a React portal with Home, Staff and College screens.

## 3. Security analysis

| Threat | Mitigation |
|--------|------------|
| Admin opens the paper early | Admin never holds a key or piece. The contract refuses reveals before `examTime`, and `setExam` can only run once, so the time cannot be moved earlier |
| One or two staff collude early | Shamir threshold 3: two pieces reveal nothing about the key. Pieces only go on-chain after exam time |
| A staff member submits a fake piece (to sabotage the unlock) | Commit-reveal: every piece must match the hash posted before the exam (`HashMismatch`) |
| Replaying another staff member's piece or seed | Commitments bind the vault address and the staff address, so a copied value never matches |
| Paper swapped or edited after upload | keccak256 of the ciphertext is on-chain; the portal and `verify-hash.mjs` check it; AES-GCM also authenticates the ciphertext |
| An unauthorised party downloads | `logDownload` needs a soulbound token; tokens cannot be transferred, approved or sold |
| Staff simply don't show up | Stake + 50% penalty, callable by anyone; `postpone()` records a failed exam publicly |
| Last-revealer bias on the random pick | See §5 |
| Key leaked from the chain | The key is never on-chain; only hashes, CIDs and post-exam pieces |
| Accepted residual risks | Revealed pieces are public after the exam starts (anyone can rebuild the key then); the setter can leak before upload; the demo setter script generates all seeds |

## 4. Commitment scheme

A commitment is `keccak256(abi.encode(vault, staff, paper, piece))` (pieces) or `keccak256(abi.encode(vault, staff, seed))` (seeds). It is **hiding** because a 256-bit seed or a 33-byte Shamir share cannot be guessed from its hash, and **binding** because finding a different value with the same hash would break keccak256. Including the vault address prevents reuse across deployments; including the staff address prevents copying another staff member's reveal. `abi.encode` (not `encodePacked`) avoids ambiguous concatenations of the dynamic `bytes` piece. The off-chain helpers in `shared/vaultCrypto.mjs` are tested to produce exactly the contract's `seedCommitment` / `pieceCommitment` values.

## 5. Randomness

The paper is chosen by `keccak256(seed₁ ⊕ … ⊕ seedₖ) mod 3` over the revealed seeds. As long as one revealing staff member's seed is random and was committed before the others were revealed, nobody can predict the result. The weakness is the *last revealer*: having seen the others' seeds, they know the result with and without their own seed and could withhold it. Mitigations:

- `selectPaper` only runs early if **every committed seed** is revealed; otherwise it waits for the end of the seed window, so withholding gives no time advantage;
- withholding a seed is a missed duty and costs 50% of the stake;
- the attacker can at most choose between two outcomes, out of three papers that were all set to the same standard, so the benefit is small.

Chainlink VRF would remove the bias entirely (see §9).

## 6. Shamir secret sharing

Each 32-byte AES key is split byte-wise over GF(2⁸) with a random degree-2 polynomial per byte (`shamir-secret-sharing`, audited library). Any 3 shares interpolate the polynomial back to the key; any 2 shares are consistent with every possible key, so they leak nothing. The tests check that all 10 combinations of 3-of-5 shares decrypt the paper and that 2 shares do not give the key.

## 7. Tests and results

`npm test` runs `test/ExamVault.test.cjs` (contract, 72 tests) and `test/crypto.test.cjs` (off-chain crypto, 17 tests). Result: **89 passing, 0 failing**.

| PRD success criterion | Test | Result |
|-----------------------|------|--------|
| Revealing a piece before exam time fails | `Revealing a piece before exam time fails` | Pass |
| A wrong piece is rejected | `A wrong piece is rejected` | Pass |
| 3 valid pieces unlock the paper | `3 valid pieces unlock the paper` | Pass |
| A staff member who misses the window loses part of their deposit | `A staff member who misses the window loses part of their deposit` | Pass |
| A college without a token cannot download | `A college without a token cannot download` | Pass |
| Hash check passes on the original, fails on an edited copy | `verify-hash.mjs exits 0 on the original, 1 on the edited copy` (crypto suite) | Pass |

Gas (optional, `REPORT_GAS=true npm test`): [fill after running].

The end-to-end demo (`npm run demo:setup`, then `npm run demo:reveal -- --fast --penalise --download`) shows an early reveal failing (`TooEarly`), the random pick, a tampered piece rejected (`HashMismatch`), the unlock, a college without a token refused (`NoToken`), a successful download with hash check and decryption, and staff 4 and 5 losing 0.5 ETH each. The same flow was also run through the portal: Staff 1 revealed their seed and key from the Staff screen, and the token-holding college downloaded, hash-checked and decrypted the paper from the College screen.

## 8. Limitations

- Revealed pieces are public, so after exam time anyone can rebuild the key, not only colleges.
- A dishonest setter can leak the plaintext before encryption; the blockchain cannot see that.
- In the demo the setter script generates every staff seed, so it knows them all.
- Block timestamps can drift a few seconds from real time; windows are minutes long to absorb this.
- `setExam` runs once: a postponed exam needs a new deployment.
- Slashed stakes are locked forever rather than redistributed.
- Testnet only; the access token proves an address is registered, not who is using it.

## 9. Future work

- **Chainlink VRF on Sepolia** for unbiased paper selection [check current VRF version in Chainlink docs].
- **Per-college encrypted pieces:** staff reveal pieces encrypted to each college's public key, so only token-holding colleges can rebuild the key.
- **Verify screen and public log table** in the portal (data is already on-chain via events).
- Staff-generated seeds in the browser, distributed key generation so no setter ever sees a full key, and redistribution of slashed stakes to honest staff.
