/**
 * `?` 占位符 → PostgreSQL 的 `$1, $2…`。
 *
 * 不按正则替换：SQL 文本里可能含 `?` 的字符串字面量、注释、标识符或
 * dollar-quoted 块，正则替换会改坏它们。这里逐字符扫描，跳过：
 *   - 单引号字符串（`''` 转义）
 *   - 双引号标识符（`""` 转义）
 *   - `--` 行注释、`/* *\/` 块注释
 *   - `$tag$ … $tag$` dollar quote（标签不能以数字开头，所以 `$1` 不会被误认）
 *
 * 一套可移植 SQL 只写 `?`；PG 侧在执行前过这一道，SQLite 侧原样用。
 */

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

export const toPgPlaceholders = (sql: string): string => {
  if (!sql.includes('?')) return sql;
  let out = '';
  let index = 0;
  let params = 0;
  const length = sql.length;

  while (index < length) {
    const ch = sql[index]!;

    if (ch === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? length : end + 1;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (ch === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? length : end + 2;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let stop = index + 1;
      while (stop < length) {
        if (sql[stop] === quote) {
          if (sql[stop + 1] === quote) { stop += 2; continue; }
          stop += 1;
          break;
        }
        stop += 1;
      }
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (ch === '$') {
      const match = DOLLAR_TAG.exec(sql.slice(index));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, index + tag.length);
        const stop = end === -1 ? length : end + tag.length;
        out += sql.slice(index, stop);
        index = stop;
        continue;
      }
    }

    if (ch === '?') {
      params += 1;
      out += `$${params}`;
      index += 1;
      continue;
    }

    out += ch;
    index += 1;
  }

  return out;
};
