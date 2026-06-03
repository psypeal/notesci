import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] || "build";
if (!["build", "dev"].includes(mode)) {
  console.error(`Unsupported frontend command: ${mode}`);
  process.exit(1);
}

function findFrontendDir(start) {
  let cwd = start;
  for (let i = 0; i < 10; i += 1) {
    const frontendDir = path.join(cwd, "frontend");
    if (fs.existsSync(path.join(frontendDir, "package.json"))) {
      return frontendDir;
    }
    const next = path.dirname(cwd);
    if (next === cwd) break;
    cwd = next;
  }
  return null;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir =
  findFrontendDir(process.cwd()) ||
  findFrontendDir(scriptDir);

if (!frontendDir) {
  console.error("Cannot locate frontend package.json for Tauri");
  process.exit(1);
}

const result = spawnSync("pnpm", ["-C", frontendDir, mode], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
