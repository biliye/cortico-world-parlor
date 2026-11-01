/**
 * fetch 规范里禁用的端口：undici 连之前就拒绝（bad port）。
 * 只影响「让系统分配端口（port 0）」的测试/staging；生产用固定端口。
 */
const BLOCKED_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6679, 6697, 10080]);

export const isBlockedPort = (port: number): boolean => (
  port < 1024 || BLOCKED_PORTS.has(port) || (port >= 6665 && port <= 6669)
);
