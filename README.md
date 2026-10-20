# Time-locked exam papers (blockchain)

Exam papers leak because someone with admin access can open them early. This project
locks each paper in a smart contract so that **no single person can open it before exam
time, not even the admin.**

> Think of a bank vault with a timer and five keyholders. Three must turn their keys,
> and only after the timer ends. The blockchain is the vault's rulebook and its public
> logbook. A smart contract is a program on the blockchain that nobody can secretly change.

Stack: Solidity 0.8.28 + Hardhat 2 (contracts and tests), ethers v6 (scripts and portal),
AES-256-GCM + Shamir secret sharing (off-chain crypto), IPFS (local folder or Pinata),
React + Vite (portal).

---

## Features

| # | Feature | How it works | Where |
|---|---------|--------------|-------|
| 1 | 3-of-5 multi-sig unlock | Each paper key is split into 5 Shamir pieces. Any 3 rebuild it, 2 reveal nothing | `shared/vaultCrypto.mjs` (`splitKey`, `combineKey`), `ExamVault.revealPiece` |
| 2 | Commit-reveal | Before the exam, staff post `keccak256(vault, staff, paper, piece)`. The contract rejects any piece that does not match | `ExamVault.commitPieces` / `revealPiece`, `pieceCommitment` |
| 3 | Stake and penalty | Staff stake test ETH. Missing the seed or piece reveal costs 50% of the stake | `ExamVault.stake` / `penalise` / `withdrawStake` |
| 4 | Random paper pick | 3 papers are uploaded. Staff commit secret seeds, reveal them at exam time, and the contract picks `keccak256(XOR of seeds) mod 3` | `ExamVault.commitSeed` / `revealSeed` / `selectPaper` |
| 5 | Soulbound access tokens | ERC-721 + ERC-5192 token per college. Transfers and approvals always revert. Only holders can log a download | `contracts/CollegeAccessToken.sol`, `ExamVault.logDownload` |
| 6 | IPFS storage | Encrypted papers live off-chain. Only their CID and keccak256 hash are on-chain | `scripts/prepare-papers.mjs`, `scripts/verify-hash.mjs` |
| 7 | Web portal | Home (countdown), Staff (reveal my key), College (download and decrypt) | `frontend/` |
| – | Demo scripts | Deploy + set up everything, then play the staff at exam time | `scripts/demo-setup.mjs`, `scripts/demo-reveal.mjs` |

---

## Architecture

```
                      ┌──────────────────────────────┐
                      │  Paper setter (off-chain)    │
                      │  scripts/prepare-papers.mjs  │
                      │  encrypt A,B,C (AES-256-GCM) │
                      │  split each key 3-of-5       │
                      └───────┬───────────────┬──────┘
          encrypted files     │               │  hashes + CIDs, and a secret
          (ciphertext only)   │               │  file per staff member (pieces + seed)
                              ▼               ▼
   ┌─────────────────────────────┐   ┌───────────────────────────────────────────┐
   │ IPFS                        │   │ Blockchain — ExamVault.sol                │
   │ local: frontend/public/ipfs │   │  exam time (locked once set)              │
   │ or Pinata                   │   │  paper hashes + CIDs                      │
   │ (nobody can read it         │   │  staff stakes, piece + seed commitments   │
   │  without the key)           │   │  revealed seeds → selected paper          │
   └──────────────┬──────────────┘   │  revealed pieces (after exam time only)   │
                  │                  │  download log, penalties                  │
                  │                  │  CollegeAccessToken.sol (soulbound)       │
                  │                  └──────────────────┬────────────────────────┘
                  │  fetch ciphertext                   │  read state / send txs
                  ▼                                     ▼
              ┌───────────────────────────────────────────────────┐
              │ Portal (frontend/, React + ethers)                │
              │  Home: countdown · Staff: reveal · College:       │
              │  check token → logDownload → fetch → verify hash  │
              │  → combine 3 pieces → decrypt in the browser      │
              └───────────────────────────────────────────────────┘
```

The paper never touches the blockchain, only its hash does. The key is never on-chain
either: it only exists again when 3 pieces are combined, in the browser or script, after
exam time.

### Exam timeline

```
 setup ─────────── examTime ──── seedWindow ──┐
 register, setExam,   │ revealSeed  (120 s)    │
 stake, commit        │        selectPaper ────┼──── revealWindow (600 s) ───┐
                      │                        │  revealPiece (chosen paper)  │
                      │                        │  3 valid pieces = UNLOCKED   │
                      │                        │  logDownload (token holders) │
                      │                                                       │ penalise / withdrawStake
```

`selectPaper` runs as soon as **every committed seed** is revealed, otherwise only after the
seed window closes (with at least 3 seeds). That stops the last staff member from seeing the
result early and choosing whether to reveal.

---

## Contract functions (`contracts/ExamVault.sol`)

| Function | Who | Rule |
|----------|-----|------|
| `registerStaff(addr)` | Admin | Before `setExam`, max 5, not the admin, not a college |
| `registerCollege(addr, name)` | Admin | Before `setExam` |
| `setExam(time, hashes[3], cids[3])` | Admin | Exactly 5 staff, time in the future, runs once |
| `mintAccessToken(college)` | Admin | Registered college, one soulbound token each |
| `stake()` | Staff | Any time before exam time, adds to the deposit |
| `commitPieces(commits[3])`, `commitSeed(commit)` | Staff | After `setExam`, before exam time, stake ≥ `minStake`, once |
| `revealSeed(seed)` | Staff | After exam time, inside the seed window, must match the commitment |
| `selectPaper()` | Anyone | ≥ 3 seeds, and all seeds in or the seed window over. Picks A/B/C |
| `revealPiece(piece)` | Staff | Chosen paper only, inside the reveal window, must match the commitment |
| `logDownload()` | College | Needs a token and an unlocked paper. Records college, token and time |
| `penalise(staff)` | Anyone | After duties are over, slashes 50% from staff who missed a reveal |
| `withdrawStake()` | Staff | After duties are over. Auto-slashes an unpenalised offender first |
| `postpone()` | Anyone | Logs that the exam could not open (too few seeds/pieces in time) |
| Views | Anyone | `isUnlocked`, `dutiesOver`, `missedDuty`, `getStaff`, `getPapers`, `getRevealedPieces`, `getDownloads`, `seedCommitment`, `pieceCommitment`, … |

Custom errors (`TooEarly`, `HashMismatch`, `NoToken`, `WindowClosed`, …) make every refusal
readable in the tests, scripts and portal.

---

## Dev setup: D: drive only

All work, installs and caches stay on `D:`, never `C:`. Three mechanisms make that happen:

| Mechanism | What it does | Why |
|-----------|--------------|-----|
| `.npmrc` (project-local) | `cache=D:\npm-cache` | npm otherwise caches packages in `%LOCALAPPDATA%\npm-cache` on C: |
| `scripts/d-env.cjs` | Every npm script runs through it. It sets `LOCALAPPDATA`, `APPDATA` → `D:\blockchain-exam-cache\…`, `TEMP`/`TMP` → `D:\temp`, `npm_config_cache`, `IPFS_PATH` → `D:\ipfs`, creates those folders, then runs the command | Hardhat stores its downloaded Solidity compiler and telemetry settings under `%LOCALAPPDATA%`/`%APPDATA%`, and Node/npm write temp files to `%TEMP%` — all on C: by default |
| `hardhat.config.cjs` | Sets `LOCALAPPDATA`/`APPDATA` to the D: cache again as a safety net | Covers a bare `npx hardhat …` run outside the npm scripts |

So **always use the npm scripts** (or `node scripts/d-env.cjs <command>`). Don't `export
LOCALAPPDATA=…` in Git Bash: it mangles Windows paths and Hardhat crashes with `EINVAL`.
Install Node, Git and VS Code to a D: path as well. If you set up a global npm prefix, use
`npm config set prefix D:\npm-global`.

---

## Quick start (local Hardhat network)

```bash
npm install                      # root: Hardhat, contracts, crypto libs
npm --prefix frontend install    # portal
npm test                         # contract + crypto tests
```

Then use two (or three) terminals:

```bash
# terminal 1 — a local blockchain with 20 funded test accounts
npm run node

# terminal 2 — deploy, register, encrypt + upload papers, set the exam 2 minutes ahead,
#              stake, commit, mint the college token
npm run demo:setup               # or: npm run demo:setup -- --no-commit  (commit from the Staff screen)

# terminal 3 — the portal
npm run portal                   # open the printed URL (http://localhost:5173)
```

At exam time, either reveal through the portal's Staff screen, or let the script play staff 1-3:

```bash
npm run demo:reveal                                   # waits for real exam time with a countdown
npm run demo:reveal -- --fast --penalise --download   # jumps the chain clock, does everything
```

`demo:reveal` options: `--staff 1,2,3` (who reveals; staff 4 and 5 miss the window by default),
`--fast` (Hardhat `evm_increaseTime` instead of waiting), `--download` (college 6 logs a
download, fetches the ciphertext, checks the hash, rebuilds the key and decrypts; college 7 is
refused with `NoToken`), `--penalise` (after the reveal window, slash everyone who missed a duty
and print stakes before/after). It also shows an early reveal failing with `TooEarly` and a
tampered piece rejected with `HashMismatch`.

Exam settings come from the environment (see `.env.example`): `MIN_STAKE` (0.5 ETH),
`SEED_WINDOW` (120 s), `REVEAL_WINDOW` (600 s, the PRD's 10 minutes), `EXAM_DELAY` (120 s).
Set `PINATA_JWT` to upload to Pinata instead of the local `frontend/public/ipfs` folder.

Demo accounts (Hardhat node defaults): #0 admin, #1-#5 staff, #6 Govt. College of Engineering
(has a token), #7 City Arts College (registered, no token).

### MetaMask (optional)

The portal has a demo-account picker that signs with the Hardhat node's unlocked accounts, so
MetaMask is not required. To use MetaMask anyway: add a network with RPC
`http://127.0.0.1:8545` and chain ID `31337`, then import a Hardhat test account's private key
(printed by `npm run node`). These keys are public — never send real funds to them. After
restarting the node, clear MetaMask's activity data for that network (Settings → Advanced) or
nonces will be wrong.

### Sepolia (optional)

```bash
npx hardhat run scripts/deploy.cjs --network sepolia
```

Needs `SEPOLIA_RPC_URL` and a **testnet-only** `DEPLOYER_PRIVATE_KEY` in `.env`. It only deploys
the contract; the full scripted demo is local.

---

## Success criteria (PRD) and the tests that prove them

| PRD criterion | Proven by (`npm test`) |
|---------------|------------------------|
| ☐ Revealing a piece before exam time fails | `ExamVault › piece reveal › Revealing a piece before exam time fails` (also `seed reveal › Revealing a seed before exam time fails`) |
| ☐ A wrong piece is rejected | `ExamVault › piece reveal › A wrong piece is rejected`, `a piece for a non-selected paper is rejected`, `another staff's piece can't be replayed` |
| ☐ 3 valid pieces unlock the paper | `ExamVault › piece reveal › 3 valid pieces unlock the paper`; `vaultCrypto › Shamir 3-of-5 › any 3 of 5 shares rebuild the key and decrypt` |
| ☐ A staff member who misses the window loses part of their deposit | `ExamVault › penalties & stake withdrawal › A staff member who misses the window loses part of their deposit` |
| ☐ A college without a token cannot download | `ExamVault › colleges & downloads › A college without a token cannot download` |
| ☐ Hash check passes on the original, fails on an edited copy (by script) | `vaultCrypto › hash check › scripts/verify-hash.mjs exits 0 on the original, 1 on the edited copy` |

The demo (`demo:reveal -- --fast --penalise --download`) shows every criterion live as well.

---

## Risks and limits

| Risk / limit | Why it matters | What we do |
|--------------|----------------|------------|
| Revealed pieces are public | Anyone watching the chain can rebuild the key once 3 pieces are in | Acceptable: the exam has started. Future: encrypt pieces per college |
| Setter leaks before upload | The blockchain cannot see what happens before encryption | Out of scope, stated clearly |
| Last-revealer bias | The last staff member to reveal a seed can compute the result first and refuse to reveal | `selectPaper` waits for *all* committed seeds or the end of the seed window, so withholding doesn't speed anything up; withholding also costs 50% of the stake. They can still pick between "with my seed" and "without it" (2 outcomes) at that price. Chainlink VRF removes this fully (optional) |
| Fewer than 3 staff reveal | The paper cannot unlock | Seed + reveal windows, penalties, and `postpone()` logs the failure on-chain |
| Block time drift | Block timestamps can differ from wall clock by a few seconds | Windows are minutes long; the portal shows chain time; demo uses chain time, not `Date.now()` |
| Key stored on-chain | Everything on-chain is public | Never: only hashes, CIDs, and post-exam Shamir pieces |
| Demo seeds | `prepare-papers.mjs` generates every staff seed, so the setter knows them all | Demo simplification. In production each staff member generates and keeps their own seed |
| Slashed funds | Penalties are not paid to anyone | They stay locked in the contract forever (`slashedTotal`) — no one can profit from a slash |
| Postponement | `postpone()` only logs the event | A new exam needs a fresh deployment (`setExam` runs once) |
| Randomness | Seed XOR is good enough for a 1-of-3 pick with staked staff | Chainlink VRF on Sepolia is the optional upgrade |

---

## Project layout

```
contracts/          ExamVault.sol, CollegeAccessToken.sol
test/               ExamVault.test.cjs, crypto.test.cjs
shared/             vaultCrypto.mjs (AES, Shamir, hashes, commitments, CIDs) — used by scripts and portal
scripts/            prepare-papers.mjs, demo-setup.mjs, demo-reveal.mjs, verify-hash.mjs, deploy.cjs, d-env.cjs
papers/             paper-A.md, paper-B.md, paper-C.md (plaintext demo papers)
frontend/           React portal (reads frontend/src/deployment.json written by demo:setup)
demo-data/          generated: papers.json, deployment.json, secrets/staff-<n>.json (git-ignored)
docs/REPORT.md      project report
```

## Viva line

> "The encryption keeps the paper secret. The blockchain guarantees that no single person
> can open or change it early."
