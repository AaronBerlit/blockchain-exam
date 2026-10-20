// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CollegeAccessToken} from "./CollegeAccessToken.sol";

/// @title ExamVault
/// @notice Time-locks exam papers so no single person can open one early.
///
///  Flow (see README):
///   1. Admin registers 5 staff + colleges, then calls setExam(time, hashes, cids).
///   2. Staff stake a deposit, then commit hashes of their 3 key pieces
///      (one per paper A/B/C) and of a secret random number (seed).
///   3. After exam time, staff reveal seeds; selectPaper() XORs them to pick A/B/C.
///   4. Within `revealWindow`, staff reveal their piece for the chosen paper only.
///      Each piece must match its commitment. 3 valid pieces = paper unlocked.
///   5. Colleges holding a soulbound token log their download.
///   6. Staff who skipped a duty are slashed by penalise() (anyone may call it).
///
///  The contract never holds a key, only hashes and the Shamir shares that staff
///  reveal after exam time. The key is rebuilt off-chain from 3 shares.
contract ExamVault {
    // ------------------------------------------------------------------ config
    uint8 public constant STAFF_COUNT = 5;
    uint8 public constant THRESHOLD = 3;
    uint8 public constant PAPER_COUNT = 3;
    /// @notice Share of the stake lost for missing a duty (basis points, 5000 = 50%).
    uint16 public constant PENALTY_BPS = 5000;

    address public immutable admin;
    uint256 public immutable minStake;
    /// @notice Seconds after examTime during which seeds may be revealed.
    uint64 public immutable seedWindow;
    /// @notice Seconds after the paper is selected during which pieces may be revealed.
    uint64 public immutable revealWindow;
    CollegeAccessToken public immutable accessToken;

    // ------------------------------------------------------------------- state
    struct Staff {
        bool registered;
        uint8 index; // 1..5, used by the portal for the keyholder circles
        bool piecesCommitted;
        bool seedCommitted;
        bool seedRevealed;
        bool pieceRevealed;
        bool penalised;
        bool withdrawn;
        uint256 stake;
        bytes32 seedCommit;
        bytes32[3] pieceCommits;
    }

    struct College {
        bool registered;
        uint256 tokenId; // 0 = no token yet
        string name;
    }

    struct Download {
        address college;
        uint256 tokenId;
        uint64 time;
    }

    address[] private _staffList;
    mapping(address => Staff) private _staff;

    address[] private _collegeList;
    mapping(address => College) private _colleges;

    uint64 public examTime; // 0 = exam not set yet
    bytes32[3] private _paperHashes; // keccak256 of each encrypted file
    string[3] private _paperCids; // IPFS CIDs of the encrypted files

    uint8 public seedsCommitted;
    uint8 public seedsRevealed;
    uint256 private _seedAccumulator; // XOR of revealed seeds

    bool public paperSelected;
    uint8 public selectedPaper; // 0 = A, 1 = B, 2 = C (valid once paperSelected)
    uint64 public selectedAt;

    uint8 public piecesRevealed;
    mapping(address => bytes) private _revealedPiece;

    bool public postponed;
    uint256 public slashedTotal; // slashed deposits stay locked in the contract forever

    Download[] private _downloads;

    // ------------------------------------------------------------------ events
    event StaffRegistered(address indexed staff, uint8 index);
    event CollegeRegistered(address indexed college, string name);
    event ExamSet(uint64 examTime, bytes32[3] paperHashes, string[3] paperCids);
    event Staked(address indexed staff, uint256 amount, uint256 total);
    event PiecesCommitted(address indexed staff, bytes32[3] commits);
    event SeedCommitted(address indexed staff, bytes32 commit);
    event SeedRevealed(address indexed staff, uint256 seed);
    event PaperSelected(uint8 paper, uint64 at);
    event PieceRevealed(address indexed staff, uint8 paper, bytes piece);
    event PaperUnlocked(uint8 paper, uint64 at);
    event AccessTokenMinted(address indexed college, uint256 tokenId);
    event Downloaded(address indexed college, uint256 tokenId, uint64 time);
    event Penalised(address indexed staff, uint256 amount);
    event StakeWithdrawn(address indexed staff, uint256 amount);
    event ExamPostponed(string reason, uint64 at);

    // ------------------------------------------------------------------ errors
    error NotAdmin();
    error NotStaff();
    error NotCollege();
    error ExamAlreadySet();
    error ExamNotSet();
    error TooManyStaff();
    error NotEnoughStaff();
    error AlreadyRegistered();
    error InvalidAddress();
    error TimeNotInFuture();
    error InvalidPaper();
    error StakeTooLow();
    error ZeroDeposit();
    error AlreadyCommitted();
    error TooLate();
    error TooEarly();
    error NotCommitted();
    error AlreadyRevealed();
    error HashMismatch();
    error NotEnoughSeeds();
    error AlreadySelected();
    error NotSelected();
    error WindowClosed();
    error HasToken();
    error NoToken();
    error PaperLocked();
    error ExamPostponedErr();
    error NothingToPenalise();
    error DutiesNotOver();
    error AlreadyWithdrawn();
    error TransferFailed();

    // --------------------------------------------------------------- modifiers
    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyStaff() {
        if (!_staff[msg.sender].registered) revert NotStaff();
        _;
    }

    modifier beforeExamSet() {
        if (examTime != 0) revert ExamAlreadySet();
        _;
    }

    modifier notPostponed() {
        if (postponed) revert ExamPostponedErr();
        _;
    }

    constructor(uint256 minStake_, uint64 seedWindow_, uint64 revealWindow_) {
        admin = msg.sender;
        minStake = minStake_;
        seedWindow = seedWindow_;
        revealWindow = revealWindow_;
        accessToken = new CollegeAccessToken();
    }

    // ============================================================ admin setup

    function registerStaff(address staff) external onlyAdmin beforeExamSet {
        if (staff == address(0) || staff == admin) revert InvalidAddress();
        if (_staff[staff].registered || _colleges[staff].registered) revert AlreadyRegistered();
        if (_staffList.length >= STAFF_COUNT) revert TooManyStaff();
        _staffList.push(staff);
        Staff storage s = _staff[staff];
        s.registered = true;
        s.index = uint8(_staffList.length);
        emit StaffRegistered(staff, s.index);
    }

    function registerCollege(address college, string calldata name) external onlyAdmin beforeExamSet {
        if (college == address(0) || college == admin) revert InvalidAddress();
        if (_colleges[college].registered || _staff[college].registered) revert AlreadyRegistered();
        _collegeList.push(college);
        _colleges[college].registered = true;
        _colleges[college].name = name;
        emit CollegeRegistered(college, name);
    }

    /// @notice Locks the exam time and the 3 paper fingerprints. Can only run once.
    function setExam(uint64 time, bytes32[3] calldata paperHashes, string[3] calldata paperCids)
        external
        onlyAdmin
        beforeExamSet
    {
        if (_staffList.length != STAFF_COUNT) revert NotEnoughStaff();
        if (time <= block.timestamp) revert TimeNotInFuture();
        for (uint256 i = 0; i < PAPER_COUNT; i++) {
            if (paperHashes[i] == bytes32(0) || bytes(paperCids[i]).length == 0) revert InvalidPaper();
        }
        examTime = time;
        _paperHashes = paperHashes;
        _paperCids = paperCids;
        emit ExamSet(time, paperHashes, paperCids);
    }

    /// @notice Soulbound token for a registered college. Transfers always fail.
    function mintAccessToken(address college) external onlyAdmin {
        College storage c = _colleges[college];
        if (!c.registered) revert NotCollege();
        if (c.tokenId != 0) revert HasToken();
        c.tokenId = accessToken.mint(college);
        emit AccessTokenMinted(college, c.tokenId);
    }

    // ============================================================ staff: before exam

    function stake() external payable onlyStaff {
        if (msg.value == 0) revert ZeroDeposit();
        if (examTime != 0 && block.timestamp >= examTime) revert TooLate();
        Staff storage s = _staff[msg.sender];
        s.stake += msg.value;
        emit Staked(msg.sender, msg.value, s.stake);
    }

    /// @param commits commits[p] = pieceCommitment(this, staff, p, piece) for paper p.
    function commitPieces(bytes32[3] calldata commits) external onlyStaff {
        Staff storage s = _staff[msg.sender];
        _checkCommitWindow(s);
        if (s.piecesCommitted) revert AlreadyCommitted();
        s.piecesCommitted = true;
        s.pieceCommits = commits;
        emit PiecesCommitted(msg.sender, commits);
    }

    /// @param commit seedCommitment(this, staff, seed)
    function commitSeed(bytes32 commit) external onlyStaff {
        Staff storage s = _staff[msg.sender];
        _checkCommitWindow(s);
        if (s.seedCommitted) revert AlreadyCommitted();
        s.seedCommitted = true;
        s.seedCommit = commit;
        seedsCommitted++;
        emit SeedCommitted(msg.sender, commit);
    }

    function _checkCommitWindow(Staff storage s) private view {
        if (examTime == 0) revert ExamNotSet();
        if (block.timestamp >= examTime) revert TooLate();
        if (s.stake < minStake) revert StakeTooLow();
    }

    // ============================================================ after exam time

    function revealSeed(uint256 seed) external onlyStaff notPostponed {
        Staff storage s = _staff[msg.sender];
        if (examTime == 0) revert ExamNotSet();
        if (block.timestamp < examTime) revert TooEarly();
        if (paperSelected || block.timestamp >= uint256(examTime) + seedWindow) revert WindowClosed();
        if (!s.seedCommitted) revert NotCommitted();
        if (s.seedRevealed) revert AlreadyRevealed();
        if (seedCommitment(address(this), msg.sender, seed) != s.seedCommit) revert HashMismatch();
        s.seedRevealed = true;
        seedsRevealed++;
        _seedAccumulator ^= seed;
        emit SeedRevealed(msg.sender, seed);
    }

    /// @notice Picks paper A, B or C from the staff seeds. Anyone may call it once
    ///         every committed seed is revealed, or once the seed window has closed
    ///         with at least THRESHOLD seeds revealed.
    function selectPaper() external notPostponed {
        if (paperSelected) revert AlreadySelected();
        if (examTime == 0) revert ExamNotSet();
        if (block.timestamp < examTime) revert TooEarly();
        if (seedsRevealed < THRESHOLD) revert NotEnoughSeeds();
        bool allIn = seedsRevealed == seedsCommitted;
        if (!allIn && block.timestamp < uint256(examTime) + seedWindow) revert TooEarly();
        paperSelected = true;
        selectedPaper = uint8(uint256(keccak256(abi.encode(_seedAccumulator))) % PAPER_COUNT);
        selectedAt = uint64(block.timestamp);
        emit PaperSelected(selectedPaper, selectedAt);
    }

    /// @param piece this staff member's Shamir share of the chosen paper's key.
    function revealPiece(bytes calldata piece) external onlyStaff notPostponed {
        Staff storage s = _staff[msg.sender];
        if (!paperSelected) revert NotSelected();
        if (block.timestamp >= uint256(selectedAt) + revealWindow) revert WindowClosed();
        if (!s.piecesCommitted) revert NotCommitted();
        if (s.pieceRevealed) revert AlreadyRevealed();
        if (pieceCommitment(address(this), msg.sender, selectedPaper, piece) != s.pieceCommits[selectedPaper]) {
            revert HashMismatch();
        }
        s.pieceRevealed = true;
        _revealedPiece[msg.sender] = piece;
        piecesRevealed++;
        emit PieceRevealed(msg.sender, selectedPaper, piece);
        if (piecesRevealed == THRESHOLD) emit PaperUnlocked(selectedPaper, uint64(block.timestamp));
    }

    // ============================================================ colleges

    /// @notice Records that a token-holding college fetched the unlocked paper.
    function logDownload() external {
        uint256 tokenId = _colleges[msg.sender].tokenId;
        // Token is soulbound, so the original college is always its holder.
        if (tokenId == 0 || accessToken.ownerOf(tokenId) != msg.sender) revert NoToken();
        if (!isUnlocked()) revert PaperLocked();
        _downloads.push(Download(msg.sender, tokenId, uint64(block.timestamp)));
        emit Downloaded(msg.sender, tokenId, uint64(block.timestamp));
    }

    // ============================================================ penalties & stakes

    /// @notice Slashes a staff member who did not reveal both their seed and their
    ///         piece in time. Anyone may call it once the duty windows are over.
    function penalise(address staff) external {
        Staff storage s = _staff[staff];
        if (!s.registered) revert NotStaff();
        if (!dutiesOver()) revert DutiesNotOver();
        if (s.penalised || !missedDuty(staff)) revert NothingToPenalise();
        _slash(staff, s);
    }

    /// @notice Returns the remaining deposit once the exam is over. A staff member
    ///         who still owes a penalty is slashed first, automatically.
    function withdrawStake() external onlyStaff {
        Staff storage s = _staff[msg.sender];
        if (!dutiesOver()) revert DutiesNotOver();
        if (s.withdrawn) revert AlreadyWithdrawn();
        if (!s.penalised && missedDuty(msg.sender)) _slash(msg.sender, s);
        s.withdrawn = true;
        uint256 amount = s.stake;
        s.stake = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit StakeWithdrawn(msg.sender, amount);
    }

    /// @notice Logs that the exam could not open (too few seeds or pieces in time).
    function postpone() external notPostponed {
        if (examTime == 0) revert ExamNotSet();
        if (isUnlocked() || !dutiesOver()) revert DutiesNotOver();
        postponed = true;
        string memory reason = paperSelected ? "Fewer than 3 key pieces revealed in time" : "Fewer than 3 seeds revealed in time";
        emit ExamPostponed(reason, uint64(block.timestamp));
    }

    function _slash(address staff, Staff storage s) private {
        uint256 amount = (s.stake * PENALTY_BPS) / 10_000;
        s.stake -= amount;
        s.penalised = true;
        slashedTotal += amount;
        emit Penalised(staff, amount);
    }

    // ============================================================ views

    function isUnlocked() public view returns (bool) {
        return piecesRevealed >= THRESHOLD;
    }

    /// @notice True once no more seeds or pieces can be revealed.
    function dutiesOver() public view returns (bool) {
        if (examTime == 0) return false;
        if (paperSelected) return block.timestamp >= uint256(selectedAt) + revealWindow;
        // Not selected: over once the seed window closed without enough seeds.
        return block.timestamp >= uint256(examTime) + seedWindow && seedsRevealed < THRESHOLD;
    }

    /// @notice Whether a staff member skipped revealing their seed or (if a paper
    ///         was picked) their piece.
    function missedDuty(address staff) public view returns (bool) {
        Staff storage s = _staff[staff];
        if (!s.seedRevealed) return true;
        return paperSelected && !s.pieceRevealed;
    }

    function seedCommitment(address vault, address staff, uint256 seed) public pure returns (bytes32) {
        return keccak256(abi.encode(vault, staff, seed));
    }

    function pieceCommitment(address vault, address staff, uint8 paper, bytes memory piece)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(vault, staff, paper, piece));
    }

    function getStaffList() external view returns (address[] memory) {
        return _staffList;
    }

    function getCollegeList() external view returns (address[] memory) {
        return _collegeList;
    }

    struct StaffView {
        bool registered;
        uint8 index;
        uint256 stake;
        bool piecesCommitted;
        bool seedCommitted;
        bool seedRevealed;
        bool pieceRevealed;
        bool penalised;
        bool withdrawn;
    }

    function getStaff(address staff) external view returns (StaffView memory) {
        Staff storage s = _staff[staff];
        return StaffView(
            s.registered,
            s.index,
            s.stake,
            s.piecesCommitted,
            s.seedCommitted,
            s.seedRevealed,
            s.pieceRevealed,
            s.penalised,
            s.withdrawn
        );
    }

    function getPieceCommits(address staff) external view returns (bytes32[3] memory) {
        return _staff[staff].pieceCommits;
    }

    function getCollege(address college) external view returns (College memory) {
        return _colleges[college];
    }

    function getPapers() external view returns (bytes32[3] memory hashes, string[3] memory cids) {
        return (_paperHashes, _paperCids);
    }

    /// @notice Staff who revealed a piece, and their pieces, in staff order.
    function getRevealedPieces() external view returns (address[] memory who, bytes[] memory pieces) {
        who = new address[](piecesRevealed);
        pieces = new bytes[](piecesRevealed);
        uint256 n;
        for (uint256 i = 0; i < _staffList.length; i++) {
            address a = _staffList[i];
            if (_staff[a].pieceRevealed) {
                who[n] = a;
                pieces[n] = _revealedPiece[a];
                n++;
            }
        }
    }

    function getDownloads() external view returns (Download[] memory) {
        return _downloads;
    }
}
