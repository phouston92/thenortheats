import { spawn } from "node:child_process";
const tasks = ["dev:api", "dev:worker", "dev:web", "dev:partner", "dev:admin"];
const children = tasks.map((task) =>
  spawn("pnpm", [task], { stdio: "inherit" }),
);
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
for (const child of children)
  child.on("exit", (code) => {
    if (!stopping) stop(code || 1);
  });
