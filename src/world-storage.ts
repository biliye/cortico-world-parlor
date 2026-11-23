/** 客厅 World 的本机存储声明与家长钥匙归属指纹工具。 */
import { createHash } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import type { StoragePart } from 'cortico/core/types.ts';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function ownerKeyBinding(issuer: string, key: string): string {
  return `${issuer}|${createHash('sha256').update(key).digest('base64url')}`;
}

export function roomStoragePart(file: string): StoragePart {
  return {
    key: 'parlor-room',
    label: '客厅房间数据',
    kind: 'disk',
    location: file,
    danger: true,
    note: '删除后房间、席位与聊天记录都会消失；服务器正在跑时要重启才会从空房间重建。',
    stat: () => {
      try { return `${Math.ceil(statSync(file).size / 1024)} KB`; } catch { return '不存在'; }
    },
    clear: () => {
      try { rmSync(file, { force: true }); return '房间数据已删除，重启后从空房间开始。'; } catch (error) { return `删不掉：${messageOf(error)}`; }
    },
  };
}

export function identityStoragePart(file: string): StoragePart {
  return {
    key: 'parlor-identity',
    label: '客厅账本身份',
    kind: 'disk',
    location: file,
    danger: true,
    note: '删掉后会生成新身份，之前的账本记录接不上；席位令牌不受影响。',
    stat: () => {
      try { return `${statSync(file).size} B`; } catch { return '不存在'; }
    },
    clear: () => {
      try { rmSync(file, { force: true }); return '账本身份已删除，下次启动生成新的。'; } catch (error) { return `删不掉：${messageOf(error)}`; }
    },
  };
}

export function cursorStoragePart(file: string): StoragePart {
  return {
    key: 'parlor-cursor',
    label: '客厅补看游标',
    kind: 'disk',
    location: file,
    note: '只记录读到哪里；删掉后重启会把房间历史重新补看一遍。',
    stat: () => {
      try { return `${statSync(file).size} B`; } catch { return '不存在'; }
    },
    clear: () => {
      try { rmSync(file, { force: true }); return '游标已删除。'; } catch (error) { return `删不掉：${messageOf(error)}`; }
    },
  };
}
