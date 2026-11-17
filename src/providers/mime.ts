// Builds an RFC 5322 message (used for Gmail drafts/sends).

function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

function base64Lines(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/.{1,76}/g, "$&\r\n");
}

function sanitize(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

export function buildMime(p: {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `To: ${p.to.map(sanitize).join(", ")}`,
    p.cc?.length ? `Cc: ${p.cc.map(sanitize).join(", ")}` : "",
    `Subject: ${encodeHeader(sanitize(p.subject))}`,
    p.inReplyTo ? `In-Reply-To: ${sanitize(p.inReplyTo)}` : "",
    p.references ? `References: ${sanitize(p.references)}` : "",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  return headers.join("\r\n") + "\r\n\r\n" + base64Lines(p.body);
}

export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}
