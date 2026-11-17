// Small WebCrypto helpers: encryption at rest, signed session cookies, PKCE.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(bytes = 16): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secretB64: string): Promise<CryptoKey> {
  let k = keyCache.get("aes:" + secretB64);
  if (!k) {
    const raw = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
    if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be base64 of exactly 32 bytes (run `npm run gen-secrets`).");
    k = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set("aes:" + secretB64, k);
  }
  return k;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get("hmac:" + secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set("hmac:" + secret, k);
  }
  return k;
}

export async function encrypt(secretB64: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secretB64), enc.encode(plaintext));
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

export async function decrypt(secretB64: string, sealed: string): Promise<string> {
  const [ivPart, ctPart] = sealed.split(".");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecode(ivPart) },
    await aesKey(secretB64),
    b64urlDecode(ctPart),
  );
  return dec.decode(pt);
}

export async function sign(secret: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return `${value}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verify(secret: string, signed: string): Promise<string | null> {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const sig = b64urlDecode(signed.slice(i + 1));
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(value));
  return ok ? value : null;
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomId(32);
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return { verifier, challenge: b64urlEncode(new Uint8Array(digest)) };
}
