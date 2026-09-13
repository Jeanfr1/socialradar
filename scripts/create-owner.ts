/**
 * Creates a workspace administrator.
 *
 *   npm run setup:owner -- --email you@agency.com --name "Your Name"
 *
 * The password is read from BRANDPULSE_OWNER_PASSWORD or prompted on the terminal without echo.
 * Loads .env.local (DATABASE_URL) when present.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { isAppError } from "@/server/auth/authz";
import { createUserAsSystem } from "@/server/brands/service";
import { closeDb, getDb } from "@/server/db/client";
import { redactText } from "@/server/security/redact";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");

/** Reads a line from the TTY without echoing it; falls back to the first stdin line when piped. */
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    for await (const chunk of stdin) {
      data += String(chunk);
      if (data.includes("\n")) break;
    }
    return data.split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { email: { type: "string" }, name: { type: "string" } },
    strict: true,
  });
  if (!values.email || !values.name) {
    console.error('Usage: npm run setup:owner -- --email you@agency.com --name "Your Name"');
    return 2;
  }

  let password = process.env.BRANDPULSE_OWNER_PASSWORD ?? "";
  if (!password) {
    password = await readHidden("Password (min 12 characters): ");
    const confirm = await readHidden("Confirm password: ");
    if (password !== confirm) {
      console.error("Passwords do not match.");
      return 1;
    }
  }

  const user = await createUserAsSystem(getDb(), {
    email: values.email,
    name: values.name,
    password,
    isWorkspaceAdmin: true,
  });
  console.log(`Created workspace admin ${user.email} (id ${user.id}).`);
  console.log("Next: sign in, create your brands, then add Buffer connections (Settings → Connections).");
  return 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((err: unknown) => {
    console.error(isAppError(err) ? err.message : `Failed to create owner: ${redactText(String((err as Error)?.message ?? err))}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
