# 12 — Invoker stream decoding and top-level error handling

Status: ready-for-agent
Depends-on: 05
Verification: bun test tests/invoker.test.ts

Found in review:

- `src/invoker.ts` concatenates raw chunks (`stdout += chunk`): a multi-byte UTF-8 character split across chunk boundaries corrupts the captured output — and runner output is our primary debugging artifact for the local model.
- No top-level handler in `index.ts`: an unhandled rejection can kill the process without a useful message.

Changes:

- Decode child stdout/stderr with a streaming-safe decoder (`TextDecoder` with `{ stream: true }` per chunk, or collect Buffers and decode once at the end).
- `index.ts`: catch any escape from `main()` (including unhandled rejections), print the error to stderr, exit 1.

## Acceptance criteria

- Invoker test: a fake backend that writes a multi-byte character split across two writes (e.g. `ñ`/emoji flushed byte-by-byte) is captured intact.
- Existing invoker tests (timeout, env merge, no shell interpolation) still pass unchanged.
