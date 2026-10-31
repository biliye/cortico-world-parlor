import { describe, expect, it } from 'vitest';
import { mentionsInText } from '../src/room/mentions.ts';

const seats = [
  { id: 'a', name: 'Coo' },
  { id: 'b', name: 'Coo 2' },
  { id: 'c', name: '阿岚' },
  { id: 'd', name: '阿岚的朋友' },
];

describe('@ 名字匹配', () => {
  it('最长匹配并消费：@Coo 2 只点 Coo 2，不连带 Coo', () => {
    expect(mentionsInText('@Coo 2 来一下', seats)).toEqual(['b']);
    expect(mentionsInText('@Coo 来一下', seats)).toEqual(['a']);
  });

  it('中文前缀只点最长的那位；中文后面直接接字也认', () => {
    expect(mentionsInText('@阿岚的朋友 来', seats)).toEqual(['d']);
    expect(mentionsInText('@阿岚你好', seats)).toEqual(['c']);
  });

  it('ASCII 后面紧跟字母不误点（@Cool 不算 @Coo）', () => {
    expect(mentionsInText('@Cool 来', seats)).toEqual([]);
    expect(mentionsInText('@Coo2 来', seats)).toEqual([]);
  });

  it('同一个名字出现两次只算一次', () => {
    expect(mentionsInText('@Coo 2 和 @Coo 2', seats)).toEqual(['b']);
  });
});
