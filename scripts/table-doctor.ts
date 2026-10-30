#!/usr/bin/env node
/**
 * 牌桌诊断与抢修（要先把 parlor-world 服务停掉：只允许一个写进程）。
 *
 * node --experimental-strip-types scripts/table-doctor.ts --db /var/lib/parlor/parlor.db --list
 * node --experimental-strip-types scripts/table-doctor.ts --db /var/lib/parlor/parlor.db \
 *   --void t-xxxx --note "存档读不出来"
 *
 * --list  列出所有未结束的桌（含已隔离的），以及每桌的房间/游戏/状态/版本。
 * --void  把一张桌作废：按开局那条 ante 的实际扣款明细原路退回，写公开事件与每人的信。
 *         已经正常结算/作废过的桌不会再退一次（table_finalizations 拦住）。
 *
 * 恢复规则与服务器启动时完全一致（同一个 TableHost）：短停机续局、>30 分钟作废退款、
 * 读不懂的快照只隔离那一桌。
 */
import { openDb, migrate } from '../src/room/db.ts';
import { RoomHost } from '../src/room/room-host.ts';

const argv = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (flag: string): boolean => argv.includes(flag);

const dbFile = valueOf('--db') ?? process.env.PARLOR_DB ?? '';
if (!dbFile) {
  console.error('要写 --db <parlor.db>（或设 PARLOR_DB）');
  process.exit(2);
}
const voidId = valueOf('--void');
const note = valueOf('--note') ?? '运营者处理';
const listOnly = has('--list') || !voidId;
if (!listOnly && !voidId) {
  console.error('要么 --list，要么 --void <tableId>');
  process.exit(2);
}

const db = openDb(dbFile);
try {
  migrate(db);
  const rooms = db.prepare(
    `SELECT DISTINCT room_id FROM tables WHERE status IN ('open','bidding','playing') OR frozen_at IS NOT NULL`,
  ).all() as { room_id: string }[];
  let targetRoom = '';
  if (voidId) {
    const row = db.prepare('SELECT room_id FROM tables WHERE id = ?').get(voidId) as { room_id: string } | undefined;
    if (!row) {
      console.error(`没有这张桌：${voidId}`);
      process.exit(1);
    }
    targetRoom = row.room_id;
  }

  // 与线上同一套恢复逻辑：构造 RoomHost 时会读快照、算停机、必要时隔离/退款。
  const hosts = new Map<string, RoomHost>();
  for (const row of rooms) hosts.set(row.room_id, new RoomHost(db, row.room_id));
  if (targetRoom && !hosts.has(targetRoom)) hosts.set(targetRoom, new RoomHost(db, targetRoom));

  if (listOnly) {
    const rows = db.prepare(
      `SELECT id, room_id, game, status, revision, frozen_at, recovery_error, deadline_at, updated_at
         FROM tables
        WHERE status IN ('open','bidding','playing') OR frozen_at IS NOT NULL
        ORDER BY room_id, created_at`,
    ).all() as Array<{
      id: string; room_id: string; game: string; status: string; revision: number;
      frozen_at: number | null; recovery_error: string | null;
      deadline_at: number | null; updated_at: number;
    }>;
    if (rows.length === 0) {
      console.log('没有未结束的桌。');
    }
    for (const row of rows) {
      const frozen = row.frozen_at ? ` 隔离：${row.recovery_error ?? '（没有原因）'}` : '';
      console.log(
        `${row.id}  房间 ${row.room_id}  ${row.game}  ${row.status}  rev ${row.revision}`
        + `  截止 ${row.deadline_at ? new Date(row.deadline_at).toISOString() : '—'}${frozen}`,
      );
    }
    const pending = db.prepare(
      `SELECT COUNT(*) AS n FROM table_finalizations WHERE at > ?`,
    ).get(Date.now() - 24 * 3_600_000) as { n: number };
    console.log(`最近 24 小时终态记录：${pending.n} 条。`);
  } else {
    const host = hosts.get(targetRoom)!;
    const done = host.voidTable(voidId!, note);
    if (!done) {
      console.error(`这个客厅里找不到这张桌：${voidId}（可能已经结束/作废）`);
      process.exit(1);
    }
    console.log(`已作废 ${voidId}，押注按开局明细退回；玩家会在信箱收到通知。`);
  }
} finally {
  db.close();
}
