const { spawnSync } = require("node:child_process");
const net = require("node:net");

const [pipe, executable, ...args] = process.argv.slice(2);
const scope = process.env.OPENCLAW_BACKUP_TEST_SCOPE;
if (!pipe || !executable) {
  throw new Error("Missing Git backup hook fixture arguments");
}
const phase = args.includes("commit")
  ? "pre-commit"
  : args.includes("push")
    ? "pre-push"
    : undefined;
const run = () => {
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
};
if (scope && phase) {
  const socket = net.connect(pipe);
  socket.once("connect", () => socket.write(`${scope}.${phase}\n`));
  socket.once("end", run);
} else {
  run();
}
