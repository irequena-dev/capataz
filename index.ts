import { main } from "./src/cli";

function die(error: unknown): never {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}

process.on("unhandledRejection", die);
process.on("uncaughtException", die);

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  die(error);
}
