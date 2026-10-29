// ID + password sign-in for the admin panel. The site is static (GitHub Pages), so there is no server to check a
// password. Instead the GitHub token is stored ENCRYPTED with a key made from the ID + password (PBKDF2-SHA256 ->
// AES-GCM, all in the browser). The encrypted file is public like the rest of the site, so the password is the only
// protection: a long password matters.

export const LOGIN_FILE = "admin-login.json"; // at the site root, outside admin/ (deploy_admin.py replaces admin/)
const ITERATIONS = 600000;
const enc = new TextEncoder();

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFor(id, password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", enc.encode(`${id.trim().toLowerCase()}\n${password}`), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Encrypt `payload` ({ token, repo, dataRepo }) with the ID + password; returns the login file's JSON text. */
export async function lock(id, password, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(id, password, salt, ITERATIONS);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(payload)));
  return JSON.stringify({ v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) }, null, 1) + "\n";
}

/** Decrypt a login file with the ID + password; throws "Wrong ID or password" when they do not match. */
export async function unlock(file, id, password) {
  try {
    const key = await keyFor(id, password, unb64(file.salt), file.iterations || ITERATIONS);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, key, unb64(file.data));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (_) {
    throw new Error("Wrong ID or password.");
  }
}

/** The site's login file, or null when no ID + password has been set up yet. */
export async function fetchLogin(site) {
  try {
    const r = await fetch(site + LOGIN_FILE, { cache: "no-store" });
    if (!r.ok) return null;
    const file = await r.json();
    return file && file.data && file.salt && file.iv ? file : null;
  } catch (_) {
    return null;
  }
}
