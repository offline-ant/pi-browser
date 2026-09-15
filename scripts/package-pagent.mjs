#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pagent = fileURLToPath(new URL("../../pagent/", import.meta.url));
const vendor = path.join(pagent, "vendor");
function run(args, cwd, capture = false) {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} exited ${result.status}`);
  return result.stdout;
}
run(["run", "check"], root);
run(["run", "compile"], root);
await mkdir(vendor, { recursive: true });
const packed = JSON.parse(run(["pack", "--ignore-scripts", "--json", "--pack-destination", vendor], root, true));
if (packed.length !== 1 || typeof packed[0].filename !== "string") throw new Error("npm pack returned no unique package");
const artifact = path.join(vendor, packed[0].filename);
run(["install", "--ignore-scripts", "--save-exact", artifact], pagent);
console.log(`Portable Pagent dependency refreshed: ${artifact}`);
