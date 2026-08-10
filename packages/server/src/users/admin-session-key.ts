export const adminSessionKeyFamilyPrefix = "imageshow:session:";
const adminSessionKeyPrefix = `${adminSessionKeyFamilyPrefix}v2:`;
export const adminSessionKeyPattern = `${adminSessionKeyPrefix}*`;

export function adminSessionKey(id: string) {
  return `${adminSessionKeyPrefix}${id}`;
}
