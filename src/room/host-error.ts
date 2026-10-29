/** HTTP 网关与客厅运行时共用的错误码；服务器按 code 映射状态码。 */
export type HostErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'full' | 'already_seated';

export class HostError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'HostError';
  }
}
