/** HTTP 网关与客厅运行时共用的错误码；服务器按 code 映射状态码。 */
export type HostErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'full' | 'already_seated' | 'gone';

type TableActionRetry = {
  table: string;
  revision: number;
  deadline: number;
  action: string;
  params: Record<string, unknown>;
};

export class HostError extends Error {
  readonly code: HostErrorCode;
  readonly retry?: TableActionRetry;

  constructor(code: HostErrorCode, message: string, retry?: TableActionRetry) {
    super(message);
    this.code = code;
    this.retry = retry;
    this.name = 'HostError';
  }
}
