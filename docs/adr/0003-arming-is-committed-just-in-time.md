# Arming is committed just-in-time, per Issue

The Armorer runs immediately before each Issue is dispatched, not upfront for the whole Plan. Sequence per Issue: arm → verify red-on-arrival → commit the Arming → dispatch the Executor. On escalation, the branch tip is hard-reset to the commit before the Arming, and the Arming is preserved as a patch in the run directory. Amends the mitigation in ADR 0002 ("first commit of the run"): the Arming is now one commit per Issue, just-in-time.

Rejected alternative — arming the whole Plan upfront: the Armorer would have to guess the APIs of code that later Issues haven't built yet, so its tests may not even compile, any misalignment between consecutive Issues invalidates downstream Armings, and every Verification would have to dodge the not-yet-implemented red tests sitting in the tree.

## Consequences

- The Armorer sees the real repo state (including previous Issues' work), so its tests compile and are red for the right reason.
- Two commits per Issue (Arming, then implementation); a run's branch history stays green checkpoint by checkpoint.
- Escalation rewrites the branch tip (safe: the branch is never pushed mid-run), so a failed Issue leaves no red tests behind to break later Issues' full-suite gate; the human recovers the Arming from the saved patch.
- The full contract is never visible upfront; the human approves prose criteria at the HITL gate, not the tests themselves.
