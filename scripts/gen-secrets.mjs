// Prints fresh random secrets. Usage: npm run gen-secrets
import { randomBytes } from "node:crypto";
console.log(`ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
console.log(`SESSION_SECRET=${randomBytes(32).toString("base64url")}`);
