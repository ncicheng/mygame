import type { Request, Response } from 'express';

/** HTTP 服务错误：携带状态码与可读中文信息 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 从请求头解析 Bearer token；缺失或格式错误返回 null */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return null;
  }
  return token;
}

/** 包装异步处理器：统一把 HttpError 映射为 HTTP 状态码，其余为 500 */
export function route(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
      } else {
        console.error('[api] 未预期错误：', err);
        res.status(500).json({ error: '服务器内部错误' });
      }
    }
  };
}