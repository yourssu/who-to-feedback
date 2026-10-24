import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
// Versioned, randomly salted PBKDF2; old Bun accounts are intentionally not migrated.
const iterations = 600_000;
async function derive(password: string, salt: Uint8Array, count: number) {
  // Web Crypto on hosted Workers caps PBKDF2 at 100,000 iterations.
  // Use the portable implementation to preserve the intended work factor.
  return pbkdf2Async(sha256, new TextEncoder().encode(password), salt, {
    c: count,
    dkLen: 32,
  });
}
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export async function passwordHash(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${hex(salt)}$${hex(await derive(password, salt, iterations))}`;
}
export async function passwordVerify(password: string, stored: string) {
  const [algorithm, count, salt, expected] = stored.split("$");
  if (
    algorithm !== "pbkdf2-sha256" ||
    Number(count) !== iterations ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{64}$/.test(expected ?? "")
  )
    return false;
  const actual = hex(
    await derive(
      password,
      Uint8Array.from(salt.match(/../g)!, (x) => parseInt(x, 16)),
      Number(count),
    ),
  );
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
