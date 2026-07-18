# capataz

AFK development orchestrator: walks a Plan of Issues and dispatches each one to LLM backends (Executor, Armorer, Reviewer, Fixers, Auditors) with verification between steps. See `CONTEXT.md` and `docs/design.md`.

## Requirements

- [Bun](https://bun.com)
- The CLI used by your configured backends (e.g. `devin`), installed and authenticated

## Install

```bash
git clone https://github.com/irequena-dev/capataz.git
cd capataz
bun install
bun link
```

`bun link` registers a global `capataz` command (make sure `~/.bun/bin` is on your `PATH`).

## Usage

From the target repo (or with `--repo`):

```bash
capataz run .scratch/<feature> [--issue NN] [--repo <path>] [--no-judge]
```

- The target repo needs a Plan under `.scratch/<feature>/` (PRD + Issues with `Status: ready-for-agent`).
- Backends and budgets come from `capataz.yaml` in the target repo (overriding `~/.config/capataz/config.yaml`).

Without linking, the equivalent is:

```bash
bun /path/to/capataz/index.ts run .scratch/<feature> --repo <path>
```

## Development

```bash
bun test
npx tsc --noEmit
```
