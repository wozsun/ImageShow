// Admin credential policy, mirroring the server's adminUsernameInput / adminPasswordInput.
// Used to gate the create-user, reset-password and change-password forms before they hit the
// API (the server re-validates regardless).

// At least 8 characters with at least one letter and one digit.
export const passwordPolicyHint = "至少 8 位，需含字母和数字";

export function isValidAdminPassword(value: string) {
  return value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

// Length of the auto-generated password in the create-user form. A code-front constant
// (not a config.json field) — tune it here. Used only by generateAdminPassword below.
const generatedPasswordLength = 12;

// Character pools for the generated password — curated to drop visually ambiguous glyphs
// (I/L/O, i/l/o, 0/1) so a copied/typed password isn't misread.
const passwordLetters = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
const passwordDigits = "23456789";
const passwordAlphabet = passwordLetters + passwordDigits;

function pick(pool: string, byte: number) {
  return pool[byte % pool.length];
}

// Generates a `generatedPasswordLength`-char random password that always satisfies the policy:
// one guaranteed letter + one guaranteed digit, the rest from the full pool, then shuffled so
// the guaranteed positions aren't fixed. Uses crypto for unbiased randomness.
export function generateAdminPassword(): string {
  const length = Math.max(8, generatedPasswordLength);
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const chars = [pick(passwordLetters, bytes[0]), pick(passwordDigits, bytes[1])];
  for (let i = 2; i < length; i += 1) chars.push(pick(passwordAlphabet, bytes[i]));
  const order = new Uint8Array(length);
  crypto.getRandomValues(order);
  for (let i = length - 1; i > 0; i -= 1) {
    const j = order[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
