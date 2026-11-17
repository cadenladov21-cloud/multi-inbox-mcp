// Generates the two server secrets and uploads them straight to Cloudflare (nothing is printed or saved).
// Usage: npm run setup-secrets            (uses wrangler.jsonc)
//        npm run setup-secrets -- -c wrangler.mine.jsonc
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const extra = process.argv.slice(2);
const secrets = {
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(32).toString("base64url"),
};

for (const [name, value] of Object.entries(secrets)) {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name, ...extra], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`\nFailed to set ${name}. Did you run \`npx wrangler login\` and \`npx wrangler deploy\` first?`);
    process.exit(1);
  }
}
console.log("\n✓ ENCRYPTION_KEY and SESSION_SECRET are set. Don't run this again later: a new ENCRYPTION_KEY means re-linking every inbox.");
