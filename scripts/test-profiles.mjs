// Explicit fast suite: newly added tests stay in the full suite until classified.
export const unitTests = [
  'accounts', 'announcement-rules', 'club-state', 'ddz-e2e-flow', 'ddz-end-web',
  'describe-contract', 'doudizhu-assist', 'doudizhu-bot', 'doudizhu-table', 'doudizhu',
  'focus', 'game-actions', 'game-api', 'games-registry', 'gomoku-table', 'gomoku-view', 'history-panel',
  'identity', 'ledger', 'local-history-web', 'local-history', 'mail', 'mentions',
  'monopoly-activity', 'monopoly-bot', 'monopoly-hardening', 'monopoly-integration',
  'monopoly-rules', 'monopoly-table', 'monopoly2d-rules', 'monopoly2d-table',
  'parent-web', 'parlor-patch', 'play-seat-expiry', 'play',
  'promise-room', 'reconnect', 'replay', 'room-carousel', 'room', 'rooms',
  'seat-switch', 'social', 'table-chat', 'table', 'theme-toggle', 'theme',
  'visibility-interval', 'wake-budget', 'werewolf-e2e-flow', 'werewolf-inspections-web',
  'werewolf-rules', 'werewolf-sim', 'werewolf-start-web', 'werewolf-table',
  'werewolf-web', 'world-room-transition', 'world-support', 'world-table-revision', 'world-wake', 'world',
  'test-runner',
].map(name => `tests/${name}.test.ts`);

export const pgSmokeTests = [
  'tests/pg-lifecycle-upgrade.test.ts',
  'tests/lifecycle-account.test.ts',
  'tests/table-host.test.ts',
  'tests/ledger-db.test.ts',
  'tests/pg-test-resources.test.ts',
];

export function planTests(mode = 'unit', filters = []) {
  if (!['unit', 'pg', 'all'].includes(mode)) throw new Error('测试模式只支持 unit / pg / all');
  if (mode === 'all' && filters.length) throw new Error('完整回归不接受文件或用例筛选；指定回归请用 test:pg');
  if (filters.some(value => value === '--config' || value.startsWith('--config='))) {
    throw new Error('请用 test / test:pg / test:all 选择模式，不覆盖受管测试配置');
  }
  // Explicit PG file requests through `pnpm test <file>` also use real PG.
  const paths = filters.filter(value => value.endsWith('.test.ts')).map(value => value.replaceAll('\\','/'));
  if (mode === 'unit' && paths.some(path => !unitTests.includes(path.startsWith('tests/') ? path : `tests/${path}`))) mode = 'pg';
  const targeted = paths.length > 0;
  return {
    mode,
    label: mode === 'all' ? '完整回归' : mode === 'unit' ? '快测（不启动PG，不是完整回归）' : targeted ? '指定文件真实PG回归' : '核心真实PG回归（不是完整回归）',
    include: mode === 'unit' ? unitTests : mode === 'pg' && !targeted ? pgSmokeTests : ['tests/**/*.test.ts'],
    filters,
    pg: mode !== 'unit',
  };
}
