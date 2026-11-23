import type { XiangqiMove } from './games/xiangqi.ts';

/** HTTP 网关与客厅运行时共用的错误码；服务器按 code 映射状态码。 */
export type HostErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'full' | 'already_seated' | 'gone';

type XiangqiRetry = { table: string; revision: number; deadline: number; move: XiangqiMove };

export class HostError extends Error {
  readonly code: HostErrorCode;
  readonly xiangqiRetry?: XiangqiRetry;

  constructor(code: HostErrorCode, message: string, xiangqiRetry?: XiangqiRetry) {
    super(message);
    this.code = code;
    this.xiangqiRetry = xiangqiRetry;
    this.name = 'HostError';
  }
}
