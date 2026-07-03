export const passwordPolicyHint = "至少 8 位，需含字母和数字";

export function isValidAdminPassword(value: string) {
  return value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

const generatedPasswordLength = 12;

const passwordLetters = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
const passwordDigits = "23456789";
const passwordAlphabet = passwordLetters + passwordDigits;

function pick(pool: string, byte: number) {
  return pool[byte % pool.length];
}

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
