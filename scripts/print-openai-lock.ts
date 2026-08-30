import { readFile } from "node:fs/promises";

const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
  packages?: Record<string, unknown>;
};
console.log("OPENAI_LOCK_ROOT", JSON.stringify(lock.packages?.[""] ?? null));
console.log(
  "OPENAI_LOCK_PACKAGE",
  JSON.stringify(lock.packages?.["node_modules/@ai-sdk/openai"] ?? null),
);
