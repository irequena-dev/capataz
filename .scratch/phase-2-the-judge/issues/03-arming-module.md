# 03 — Arming module and git extensions

Status: done
Depends-on: 02
Verification: bun test tests/phase2/03-arming.test.ts

Implement the Armorer invocation with the red-on-arrival gate (ADR 0003, just-in-time arming), plus the git primitives the judge flow needs.

## Git extensions (`src/git.ts`)

Add to the `Git` interface and `createGit`:

- `commitArming(issue: { number: number; slug: string }): void` — stage all, commit as `capataz: arming <NN>-<slug>` (NN zero-padded to 2, same as `commitIssue`).
- `filesInCommit(ref: string): string[]` — file paths touched by that single commit (`git diff-tree --no-commit-id --name-only -r <ref>`).
- `resetHardTo(ref: string): void` — `git reset --hard <ref>` then `git clean -fd`.
- `restoreFiles(ref: string, paths: string[]): void` — `git checkout <ref> -- <paths>`; no-op on empty `paths`.
- `softResetLast(): void` — `git reset --soft HEAD~1` (uncommit, keep work in tree and index).
- `diffPatch(fromRef: string, toRef: string): string` — full patch text `git diff <fromRef> <toRef>`.

## Arming module (new file `src/arming.ts`)

```ts
export function buildArmorerPrompt(
  issue: Issue,
  doneSummaries: DoneSummary[],
  feedback: string[],
): string;

export interface ArmIssueDeps {
  issue: Issue;
  backend: Backend;
  git: Git;
  repoPath: string;
  invokeFn: InvokeFn;          // type-only import from ./loop
  verificationTimeoutMinutes: number;
  maxAttempts: number;         // attempts this arming may consume
  doneSummaries: DoneSummary[];
}

export type ArmIssueResult =
  | { kind: "armed"; commit: string; files: string[]; attemptsUsed: number }
  | { kind: "failed"; reason: string; attemptsUsed: number };

export function armIssue(deps: ArmIssueDeps): Promise<ArmIssueResult>;
```

`buildArmorerPrompt` must include: a framing line identifying the role ("You are the Armorer") with hard rules — write failing tests only, do not implement the feature, do not modify existing tests; the Issue as a `# Issue: <title>` heading followed by the body; the exact Verification command (the tests must be reachable by it); done summaries ("what exists now"); any feedback from previous failed arming attempts.

`armIssue` behaviour, per attempt (up to `maxAttempts`):

1. Invoke the Armorer backend with the prompt.
2. On invoke `timeout`: revert the tree (`revertToLastGood`), record feedback, next attempt.
3. If the working tree has no changes (`git status --porcelain` empty): revert not needed, feedback "armorer produced no changes", next attempt.
4. Run the Issue's Verification command (reuse the same spawn/timeout/cap discipline as the loop's verification — extract or reimplement; timeout from `verificationTimeoutMinutes`).
   - Exit 0 (green — red-on-arrival violated): `revertToLastGood`, feedback "tests passed on arrival; the Arming must fail before implementation", next attempt.
   - Non-zero (red): `commitArming(issue)`; resolve `{ kind: "armed", commit: git.head(), files, attemptsUsed }` where `files` is `git.filesInCommit(git.head())` minus the Issue's own markdown file (`issue.path`) — the arming commit may carry the Issue's `Status:` update, which is capataz bookkeeping, not Arming.
5. Attempts exhausted → `{ kind: "failed", reason: <last feedback>, attemptsUsed }` with a clean tree.

Do NOT touch anything under `tests/phase2/` — those are the armed tests for this plan. `bun test tests/git.test.ts` must stay green.

## Acceptance criteria

- Armorer writes files + Verification red → arming commit `capataz: arming <NN>-<slug>` exists, `files` lists exactly the committed files, tree clean.
- Verification green after arming → retry with feedback; all attempts green → `failed`, no arming commit, tree clean.
- Armorer producing no diff → `failed` after retries with "no changes" reason.
- Second-attempt prompt contains the first attempt's feedback.
