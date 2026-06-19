// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRandomnessSource} from "./interfaces/IRandomnessSource.sol";

/// @title FinalityRandomness
/// @notice Randomness beacon anchored to OPN Chain's instant finality.
///
/// @dev    HOW IT WORKS
///         On `request`, the beacon commits the consumer to a block `COMMIT_DELAY`
///         in the future. That block does not exist yet, so its hash is unknown
///         and unpredictable to everyone, including the consumer. On `reveal`,
///         once that block has been produced, its hash is mixed with a rolling
///         accumulator and the consumer/key to produce the random word.
///
///         WHY OPN SPECIFICALLY
///         Future-block-hash randomness is a known anti-pattern on Ethereum: a
///         block can be reorged, so a proposer who dislikes an outcome can rewrite
///         history, and `blockhash` is unavailable beyond 256 blocks. OPN Chain
///         uses Tendermint BFT with *instant finality and no reorgs* (see OPN
///         docs). Once the committed block is produced it is final forever, so the
///         entropy cannot be rewritten after the fact. ~1s block times also mean
///         the commit/reveal window is only seconds, not minutes. This beacon is
///         therefore load-bearing on OPN's consensus guarantees, not a generic
///         EVM trick.
///
///         THREAT MODEL (honest)
///         The proposer of the committed block still influences its hash and could
///         grind / withhold to bias a single draw. For a hackathon MVP with small
///         stakes this is acceptable and disclosed. The `IRandomnessSource`
///         interface exists precisely so a verifiable VRF replaces this beacon
///         once OPN's native oracle ships, with no consumer changes.
contract FinalityRandomness is IRandomnessSource {
    /// @notice Blocks into the future a commitment points to. At ~1s/block this
    ///         is a few seconds of wait, kept short by OPN's fast finality.
    uint256 public constant COMMIT_DELAY = 4;

    /// @notice Rolling entropy accumulator, advanced on every successful reveal.
    uint256 private _accumulator;

    /// @dev consumer => key => committed block height.
    mapping(address => mapping(uint256 => uint256)) public commitBlockOf;

    event Requested(address indexed consumer, uint256 indexed key, uint256 commitBlock);
    event Revealed(address indexed consumer, uint256 indexed key, uint256 random);
    event Recommitted(address indexed consumer, uint256 indexed key, uint256 newCommitBlock);

    /// @inheritdoc IRandomnessSource
    function request(uint256 key) external returns (uint256 availableAtBlock) {
        availableAtBlock = block.number + COMMIT_DELAY;
        commitBlockOf[msg.sender][key] = availableAtBlock;
        emit Requested(msg.sender, key, availableAtBlock);
    }

    /// @inheritdoc IRandomnessSource
    function reveal(uint256 key) external returns (uint256 random, bool ready) {
        uint256 commitBlock = commitBlockOf[msg.sender][key];
        require(commitBlock != 0, "no commitment");

        // Too early: committed block not produced yet.
        if (block.number <= commitBlock) {
            return (0, false);
        }

        bytes32 bh = blockhash(commitBlock);

        // Expired: committed block fell outside the 256-block readable window.
        // Self-heal by committing to a fresh future block.
        if (bh == bytes32(0)) {
            uint256 newCommit = block.number + COMMIT_DELAY;
            commitBlockOf[msg.sender][key] = newCommit;
            emit Recommitted(msg.sender, key, newCommit);
            return (0, false);
        }

        random = uint256(
            keccak256(abi.encodePacked(bh, _accumulator, msg.sender, key, block.prevrandao))
        );
        _accumulator = random;
        delete commitBlockOf[msg.sender][key];

        emit Revealed(msg.sender, key, random);
        return (random, true);
    }

    /// @inheritdoc IRandomnessSource
    function isReady(address consumer, uint256 key) external view returns (bool) {
        uint256 commitBlock = commitBlockOf[consumer][key];
        if (commitBlock == 0 || block.number <= commitBlock) return false;
        return blockhash(commitBlock) != bytes32(0);
    }
}
