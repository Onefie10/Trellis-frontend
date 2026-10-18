# Cross-Repo Contracts Workflow

This document explains the compatibility workflow for shared types and schemas across Trellis repositories (Frontend, API, Smart Contracts).

## Shared Types

The core types are defined in `types/cross-repo-contract.ts`. These represent the exact shapes, enums, and structures expected by the Trellis backend and smart contracts.

The types include:
- `TrellisOperationType` (e.g., DEPOSIT, SWAP)
- `TrellisStatus` (e.g., SUCCESS, PENDING)
- `TrellisErrorCode` (e.g., INSUFFICIENT_FUNDS)
- Standardized requests like `TrellisOperationRequest` and receipts like `TrellisReceipt`.

## Compatibility Workflow

To ensure seamless integration and avoid breaking changes across repos, any change to the cross-repo contracts must follow this workflow:

1. **Propose Changes:** Any modification to shared enums, required fields, or new operation types must be proposed in a cross-repo issue or discussed with maintainers of the API and Contract repos.
2. **Update Frontend Types:** Update `types/cross-repo-contract.ts` with the agreed-upon changes.
3. **Run Validation Tests:** We use Jest tests (`tests/cross-repo-contract.test.ts`) to act as drift detectors. If you change a type or enum, the test will fail. You must explicitly update the test, acknowledging the breaking change. Run `npm run test` or `npx jest tests/cross-repo-contract.test.ts` to verify.
4. **Backward Compatibility:** When possible, make changes additive (e.g., adding a new enum value) rather than modifying existing ones. If a breaking change is required, ensure API versions and `TrellisCompatibilityCheck` logic are updated accordingly.
5. **Coordinate Deployment:** Breaking changes to the contracts must be deployed in lockstep across repos, or the API must be versioned to support the frontend gracefully.

## Drift Detection

Automated tests will validate the contract's expected shape during CI. If the contract shape changes without the test also being intentionally updated, the PR will be blocked.
