# Capataz

AFK development orchestrator: a frontier model plans a task into detailed subtasks, and a local model executes them one by one through a CLI agent, with verification between steps.

## Language

**Capataz**:
The program that walks the Plan, dispatches each Issue to a Runner and decides what to do with the result (advance, retry, escalate).
_Avoid_: orchestrator, harness, scheduler

**Role**:
A function in the flow (Planner, Executor, Reviewer, Armorer, Fixer) defined by its inputs, outputs and responsibility — never by the model that performs it.
_Avoid_: agent (ambiguous with Runner)

**Backend**:
The command + model + environment combination that performs a Role (e.g. `claude-local` with Ornith, `claude-glm`, Devin CLI). Assigned to each Role in config and swappable.
_Avoid_: provider, level

**Planner**:
Role that turns a task into a Plan: PRD + Issues with acceptance criteria in prose. Writes no code and no tests.
_Avoid_: big model, architect, orchestrator

**Armorer**:
Role that turns an Issue's acceptance criteria into red tests (the Arming), after human approval of the Plan and before the Issue is dispatched.
_Avoid_: test writer

**Arming**:
The red tests produced by the Armorer for an Issue. Committed just-in-time, right before its Issue is dispatched; no other Role may modify or delete them.
_Avoid_: test fixtures, spec tests

**Red-on-arrival**:
The gate an Arming must pass before its Issue is dispatched: the Issue's Verification must fail. Green on arrival means the tests are vacuous or the feature already exists, and the Issue escalates without dispatching the Executor.
_Avoid_: sanity check, smoke test

**Executor**:
Role that executes an Issue inside a Runner: turns the armed tests green. Cannot modify the Arming.
_Avoid_: worker, small model

**Reviewer**:
Judge Role: reads an Issue's diff and approves or rejects it against its acceptance criteria. Rejects automatically if the diff modifies the Arming.
_Avoid_: verifier, QA

**Fixer**:
Role that repairs a failed Issue within the Escalation. There are two Fixer rungs (L2 and L3), each with its own Backend.
_Avoid_: repairer

**Audit**:
Final phase of a run, entered only when every Issue ended `done`: auditor Roles examine the branch's full diff one after another and emit Findings that Capataz turns into audit-Issues. Runs exactly once per run (no re-audit of audit fixes). Auditors never edit code. Skipped in an Unjudged run.
_Avoid_: final review, global QA

**Finding**:
A structured item emitted by an auditor Role: title, description, acceptance criteria and a proposed Verification. The only output an auditor produces; anything the auditor writes to the working tree is discarded.
_Avoid_: comment, report item

**audit-Issue**:
An Issue that Capataz writes from a Finding during the Audit. Dispatched through the normal loop (Arming, gates, Escalation) in the same run, up to `max_audit_issues`; a Finding without a valid Verification, or beyond the cap, is written as `needs-triage` and never dispatched.
_Avoid_: follow-up, audit ticket

**Architect**:
Auditor Role that evaluates the architecture of the result (using improve-codebase-architecture) and emits findings.
_Avoid_: refactorer

**Security Auditor**:
Auditor Role that hunts vulnerabilities (auth bypass, IDOR, XSS, secrets, unvalidated input) and emits findings.
_Avoid_: pentester

**Escalation**:
The SOC-style ladder on failure: L1 Executor retries → L2 Fixer repairs → L3 Fixer repairs → `ready-for-human`. Only the last rung stops AFK mode for that Issue.
_Avoid_: fallback, retry

**Runner**:
The CLI agent that gives tools (read/edit files, run commands) to a Backend's model. Part of the Backend, not the Role.
_Avoid_: agent, wrapper

**Plan**:
The set of artifacts for a feature under `.scratch/<feature>/`: one PRD plus N Issues.
_Avoid_: backlog, roadmap

**Issue**:
A markdown subtask with parseable fields (`Status:`, `Depends-on:`, Verification command). Unit of work that Capataz dispatches one at a time.
_Avoid_: subtask, ticket, task

**Verification**:
Executable command attached to an Issue whose exit code decides whether the Issue is done. Fixed by the Planner and approved by the human; never rewritten at runtime.
_Avoid_: check, manual validation

**Unjudged run**:
A run explicitly started without Armorer or Reviewer (per-run opt-out flag, never config). Reproduces the bare phase-1 loop (the Escalation still applies, the Audit does not); loudly marked in the report. Exists only for experiments and debugging Capataz itself.
_Avoid_: fast mode, legacy mode

**Notification**:
Best-effort ntfy push sent when a run ends, whatever the outcome, summarising the result. Never affects the run: a failed push is only a warning.
_Avoid_: alert, webhook
