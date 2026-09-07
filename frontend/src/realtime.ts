import { io, type Socket } from 'socket.io-client';
import { API_BASE } from './api';

/** 实时推送连接地址：与 fetch 同用 API_BASE。
 * 开发环境 API_BASE 为空 → 同源连接（Vite 代理 /api 到本地后端）；
 * 生产环境（GitHub Pages）API_BASE 指向后端，socket 才连得到真正的服务器。 */
export function realtimeSocketUrl(): string {
  return API_BASE;
}

/** io 工厂类型（可注入以便测试）；url 为空时退化为 io(options) 同源连接 */
type IoFactory = (...args: unknown[]) => Socket;

/** 建立实时推送 socket。每次调用都创建全新实例：React 18 StrictMode 下 effect
 * 重挂载不会复用一个已被手动 disconnect 且无法重连的缓存实例。
 * 由调用方在卸载时负责 disconnect。url 参数便于测试注入；默认取 realtimeSocketUrl()。 */
export function createRealtimeSocket(
  token: string,
  ioFactory: IoFactory = io as unknown as IoFactory,
  url: string = realtimeSocketUrl(),
): Socket {
  const options = { auth: { token } };
  return url ? ioFactory(url, options) : ioFactory(options);
}
