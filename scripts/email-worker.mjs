// Operator-only utility. Supabase CLI authentication is required.
// Secrets are never passed as arguments or printed. Setup accepts a temporary
// private env file because the CLI ignores non-regular env files such as pipes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const projectUrl = "https://pgumtergvtbeepzpgvkv.supabase.co";
let phase = "read Vault configuration";
const privateValues = [];
function cli(args, input) {
  // Node child stdin is a socket; the CLI's file reader needs a real pipe.
  return JSON.parse(
    execFileSync(
      "bash",
      [
        "-c",
        'IFS= read -r -d "" nox_input || true\nnpx --yes supabase "$@" <<< "$nox_input"',
        "nox-cli",
        ...args,
      ],
      {
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
}
const query = (sql) =>
  cli(["db", "query", "--linked", "--file", "/dev/stdin"], sql).rows;
try {
  const secrets = query(
    "select name,decrypted_secret from vault.decrypted_secrets where name in ('email_worker_secret','project_url')",
  );
  let secret = secrets.find(
    (row) => row.name === "email_worker_secret",
  )?.decrypted_secret;
  if (process.argv[2] === "setup") {
    const envFile = process.argv[3];
    if (!envFile) throw new Error("Setup requires a private env file.");
    const configuredSecret = readFileSync(envFile, "utf8").match(
      /^EMAIL_WORKER_SECRET=([a-f0-9]{64})$/m,
    )?.[1];
    if (!configuredSecret || (secret && secret !== configuredSecret))
      throw new Error("Worker secret mismatch.");
    secret = configuredSecret;
    privateValues.push(secret);
    phase = "set Edge Function configuration";
    cli(["secrets", "set", "--env-file", envFile], "");
    phase = "save Vault configuration";
    if (!secrets.some((row) => row.name === "email_worker_secret"))
      query(`select vault.create_secret('${secret}', 'email_worker_secret')`);
    if (!secrets.some((row) => row.name === "project_url"))
      query(`select vault.create_secret('${projectUrl}', 'project_url')`);
    console.log("Worker secret and project URL configured; no secret printed.");
  } else if (!secret) throw new Error("Run setup first.");
  else {
    const response = await fetch(
      `${projectUrl}/functions/v1/send-production-emails`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          process.argv[2] === "run" ? {} : process.argv[2] === "test" ? { test: true } : { diagnose: true },
        ),
      },
    );
    console.log(
      JSON.stringify({
        status: response.status,
        result: await response.json(),
      }),
    );
    if (!response.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `Email utility failed during ${phase} (${error.name}, status ${error.status ?? "unknown"}). Secret output suppressed.`,
  );
  let diagnostic = String(error.stdout || "");
  for (const value of privateValues)
    diagnostic = diagnostic.replaceAll(value, "[REDACTED]");
  if (diagnostic) console.error(diagnostic);
  process.exitCode = 1;
}
