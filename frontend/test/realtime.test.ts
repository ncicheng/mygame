import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realtimeSocketUrl, createRealtimeSocket } from '../src/realtime.js';

// 实时推送连接的关注点：
// 1) 连接地址必须与 fetch 同用 API_BASE（生产环境指向后端，而非无后端的页面源）；
// 2) 每次建立全新 socket 实例，StrictMode 下 effect 重挂载不会复用一个已被
//    手动 disconnect 且无法重连的缓存实例。

test('realtimeSocketUrl 默认与 fetch 同源（开发环境 API_BASE 为空）', () => {
  assert.equal(realtimeSocketUrl(), '', '开发环境未配置 VITE_API_BASE_URL 时应收敛为空串（同源连接）');
});

test('createRealtimeSocket 连接后端地址并携带 token 鉴权', () => {
  const calls: unknown[][] = [];
  const fakeIo = (...args: unknown[]) => {
    calls.push(args);
    return { id: calls.length };
  };

  // 生产场景：API_BASE 指向后端 → 调用 io(url, { auth })
  createRealtimeSocket('tok-prod', fakeIo as never, 'https://api.example.com');
  assert.equal(calls[0].length, 2, '配置后端地址时应以 io(url, options) 形式连接');
  assert.equal(calls[0][0], 'https://api.example.com');
  assert.deepEqual(calls[0][1], { auth: { token: 'tok-prod' } });
});

test('createRealtimeSocket 开发场景同源连接且携带 token 鉴权', () => {
  const calls: unknown[][] = [];
  const fakeIo = (...args: unknown[]) => {
    calls.push(args);
    return { id: calls.length };
  };

  // 开发场景：API_BASE 为空 → 调用 io(options)，同源连接（Vite 代理 /api）
  createRealtimeSocket('tok-dev', fakeIo as never, '');
  assert.equal(calls[0].length, 1, '未配置后端地址时应以 io(options) 形式同源连接');
  assert.deepEqual(calls[0][0], { auth: { token: 'tok-dev' } });
});

test('createRealtimeSocket 每次创建全新实例：断开一个不影响另一个（StrictMode 安全）', () => {
  const fakeIo = (...args: unknown[]) => ({ id: args.length });
  const s1 = createRealtimeSocket('t', fakeIo as never, '');
  const s2 = createRealtimeSocket('t', fakeIo as never, '');
  assert.notEqual(s1, s2, '每次调用应返回独立 socket 实例');
});
