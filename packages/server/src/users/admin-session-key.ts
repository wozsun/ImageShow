export const adminSessionKeyFamilyPrefix = "imageshow:session:";
export const adminSessionKeyPattern = `${adminSessionKeyFamilyPrefix}*`;

export function adminSessionKey(id: string) {
  return `${adminSessionKeyFamilyPrefix}${id}`;
}
