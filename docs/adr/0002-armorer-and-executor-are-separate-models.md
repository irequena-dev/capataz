# Armorer and Executor are separate models

The red tests for an Issue (the Arming) are written by a different, stronger model (Armorer, e.g. GLM via `claude-glm`) than the one that implements the Issue (Executor, e.g. a local 9B). The Executor may not modify the Arming, and the Reviewer auto-rejects any diff that touches it. This separation is the system's central bet: it turns tests into an executable spec the small model cannot game (trivial tests, hardcoded expected values, deleted tests), which is what lets an unattended 9B punch above its weight.

## Consequences

- Planning stays cheap: the frontier Planner writes only prose acceptance criteria; the Armorer (subscription-priced) turns them into tests, so frontier tokens are not spent on test code.
- If the Armorer misreads a criterion, the Executor will faithfully implement the wrong thing. Mitigation: Arming happens after human plan approval and is committed as the first commit of the run, so it is auditable.
