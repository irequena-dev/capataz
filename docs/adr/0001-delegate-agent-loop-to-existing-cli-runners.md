# Delegate the agent loop to existing CLI runners

Capataz never talks to a model API directly and implements no tool-calling loop. Every Role is performed by spawning an existing CLI agent in non-interactive mode (`claude -p` pointed at the configured endpoint, `devin -p --model X`), which already provides tools, file editing, context management and error recovery. Capataz's value is at a higher level — planning handoff, per-Issue verification, escalation, git checkpointing — and reimplementing a hardened agent loop (especially tool-call parsing for a 9B local model) would be most of the project's cost for none of its differentiation.

## Considered Options

- Custom agent loop against the OpenAI-compatible endpoint (unsloth studio at localhost:8888): full control, rejected as reinventing Claude Code.
- Delegate to CLI agents (chosen): Backends stay swappable via config; the trade-off is depending on each CLI's non-interactive interface and output format.
