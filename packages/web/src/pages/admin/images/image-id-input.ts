// 图片 ID 一律是 UUIDv7；其他写法即使是合法 UUID 也不会命中图片，按格式错误提示。
const imageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 与后台图片快照、编辑与删除接口的单次 ID 上限一致。 */
export const imageIdInputMaxItems = 200;

/**
 * 解析按 ID 指定图片的输入：逗号、空白或换行分隔，不区分大小写，重复项合并，
 * 保留首次出现的顺序；格式错误的词项原样列出。
 */
export function parseImageIdInput(text: string) {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const term of text.split(/[\s,，]+/)) {
    if (!term) continue;
    const id = term.toLowerCase();
    if (!imageIdPattern.test(id)) {
      if (!invalid.includes(term)) invalid.push(term);
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, invalid };
}
