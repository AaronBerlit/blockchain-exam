// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CollegeAccessToken
/// @notice Soulbound (non-transferable) ERC-721. One token per college; only
///         holders may log a download of the exam paper. Follows ERC-5192
///         ("Minimal Soulbound NFTs"): every token is permanently locked.
/// @dev Owned by the ExamVault that deploys it, so only the vault can mint.
contract CollegeAccessToken is ERC721, Ownable {
    /// ERC-5192 events
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    error Soulbound();

    uint256 public totalMinted;

    constructor() ERC721("ExamVault College Access", "EXAMKEY") Ownable(msg.sender) {}

    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        tokenId = ++totalMinted; // ids start at 1
        _safeMint(to, tokenId);
        emit Locked(tokenId);
    }

    /// @notice ERC-5192: always true, tokens can never move.
    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    /// @dev Every transfer path in OZ v5 ERC-721 goes through _update.
    ///      Allow only minting (from == 0); block transfers and burns.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    /// @dev Approvals are pointless for a token that cannot move, so refuse them.
    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == 0xb45a3c0e /* ERC-5192 */ || super.supportsInterface(interfaceId);
    }
}
