/**
 * 文本里的 `@名字`：从每个 @ 起按名字长度从长到短试，命中就把这一段消费掉。
 *
 * 不消费的话，「@阿岚的朋友」也会点到「阿岚」；自动加序号后的「Coo」与「Coo 2」
 * 正是这种前缀关系。纯 ASCII 单词后面紧跟字母/数字时不认（避免 @Coo 吃掉 @Cool）；
 * 中文没有空格，`@小满你好` 照常认。
 */
const ASCII_WORD = /[A-Za-z0-9_]/;

export const mentionsInText = (text: string, seats: { id: string; name: string }[]): string[] => {
  const found = new Set<string>();
  const sorted = [...seats].sort((left, right) => right.name.length - left.name.length);
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue;
    const hit = sorted.find((seat) => {
      const token = `@${seat.name}`;
      if (!text.startsWith(token, index)) return false;
      const next = text[index + token.length];
      if (next === undefined || !ASCII_WORD.test(next)) return true;
      return !ASCII_WORD.test(seat.name[seat.name.length - 1] ?? '');
    });
    if (!hit) continue;
    found.add(hit.id);
    // 跳过名字；for 的 +1 再把 @ 后面的下一格跳掉。
    index += hit.name.length;
  }
  return [...found];
};
