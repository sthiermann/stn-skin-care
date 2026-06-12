import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const [, , nextPass, ...args] = process.argv;
if (!nextPass) {
  console.error('Usage: node encrypt.mjs "NEW_PASSWORD" [--from "OLD_PASSWORD"]');
  process.exit(1);
}

const fromIndex = args.indexOf("--from");
const oldPass = fromIndex >= 0 ? args[fromIndex + 1] : "";
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => Buffer.from(u8).toString("base64");
const fromB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function derive(pass, salt, iter, usage) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

async function decryptExisting(pass) {
  const js = readFileSync("routine.data.js", "utf8").trim();
  const json = js.replace(/^window\.STN_ROUTINE_ENC=/, "").replace(/;$/, "");
  const data = JSON.parse(json);
  const key = await derive(pass, fromB64(data.salt), data.iter || 310000, "decrypt");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(data.iv) }, key, fromB64(data.ct));
  return dec.decode(clear);
}

let plain;
if (existsSync("routine.plain.json")) {
  plain = readFileSync("routine.plain.json", "utf8");
  JSON.parse(plain);
} else if (oldPass) {
  plain = await decryptExisting(oldPass);
} else {
  console.error('routine.plain.json fehlt. Alternativ: node encrypt.mjs "NEW_PASSWORD" --from "OLD_PASSWORD"');
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const iter = 310000;
const key = await derive(nextPass, salt, iter, "encrypt");
const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
const out = {
  v: 1,
  alg: "PBKDF2-SHA256-AES-GCM",
  iter,
  salt: b64(salt),
  iv: b64(iv),
  ct: b64(new Uint8Array(ct))
};

writeFileSync("routine.data.js", `window.STN_ROUTINE_ENC=${JSON.stringify(out)};\n`);
console.log(`OK -> routine.data.js (${out.ct.length} B64 chars, ${iter} iterations)`);
