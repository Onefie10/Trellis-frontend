# Governance policy changes

Policy edits in the governance dashboard are staged: edit a policy, choose **Preview Change**, inspect the old and proposed daily quota and request rate, then choose **Confirm and apply**. A change is marked high impact when either configured limit changes by 25% or more. Invalid values cannot be applied.

## Preview scope and operating edges

The preview compares configured limits only. It does not read current demand, forecast traffic, simulate downstream capacity, or guarantee that a deployment can serve the new limits. Treat the preview as a review aid, not an approval or capacity guarantee. Reopen the policy before applying if its configuration may have changed elsewhere since it was loaded.

The current `quotaService.updatePolicy` implementation is a mock that logs the submitted policy and returns success. Connect it to the authoritative policy API before relying on this screen for production changes; the local list is only updated after the service confirms success.

## Failure and recovery

- If values are zero, negative, fractional, or too large to be safe integers, the preview reports validation errors. Return to editing and enter positive whole numbers.
- If applying returns `false` or throws, the draft stays open and the visible policy list is left as it was. Retry after checking the authoritative policy state, or cancel and reload the page. If the service times out after accepting a write, check the authoritative policy before retrying to avoid duplicating a partially completed operation.
- Use **Back to edit** to discard the current preview and adjust values. Use **Cancel** to close the editor without applying.

## Verification

`lib/governance/__tests__/policySimulation.test.ts` covers impact thresholds and invalid limits. The dashboard flow can be checked manually by editing a policy, previewing a small and a 25%+ change, confirming the second step, and forcing `quotaService.updatePolicy` to reject to verify the draft remains available for recovery.
