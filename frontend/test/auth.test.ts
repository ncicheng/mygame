import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signUp, signIn, signOut, getCurrentUser, onAuthChange } from '../src/auth.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// 认证封装 auth.ts 的测试关注点：
// 1) 透传参数到 supabase.auth 的对应方法（signUp / signInWithPassword）；
// 2) Supabase 返回 error 时抛带中文 message 的 Error，而非静默吞掉；
// 3) getCurrentUser 正确收敛 User 对象，未登录返回 null；
// 4) onAuthChange 转发会话变化并返回可用的取消订阅函数。
// 依赖注入：通过可选的第三个 client 参数注入假客户端（与 realtime.ts 同款模式）。

type AuthMethod = (...args: unknown[]) => { data?: unknown; error?: { message: string } | null };

function makeFakeClient(overrides: Record<string, AuthMethod>): SupabaseClient {
  return {
    auth: {
      signUp: overrides.signUp ?? (() => ({ data: {}, error: null })),
      signInWithPassword: overrides.signInWithPassword ?? (() => ({ data: {}, error: null })),
      signOut: overrides.signOut ?? (() => ({ error: null })),
      getUser: overrides.getUser ?? (() => ({ data: { user: null }, error: null })),
      onAuthStateChange: overrides.onAuthStateChange ?? (() => ({ data: { subscription: { unsubscribe: () => {} } } })),
    },
  } as unknown as SupabaseClient;
}

test('signIn 透传邮箱密码给 auth.signInWithPassword', async () => {
  const calls: unknown[] = [];
  const client = makeFakeClient({
    signInWithPassword: (...args) => {
      calls.push(args);
      return { data: {}, error: null };
    },
  });

  await signIn('a@b.com', 'secret', client);
  assert.deepEqual(calls[0], [{ email: 'a@b.com', password: 'secret' }]);
});

test('signIn 出错时抛带中文 message 的 Error', async () => {
  const client = makeFakeClient({
    signInWithPassword: () => ({ data: {}, error: { message: 'Invalid login credentials' } }),
  });

  await assert.rejects(() => signIn('a@b.com', 'secret', client), /登录失败/);
});

test('signUp 透传邮箱密码给 auth.signUp，出错抛中文 Error', async () => {
  const calls: unknown[] = [];
  const client = makeFakeClient({
    signUp: (...args) => {
      calls.push(args);
      return { data: {}, error: null };
    },
  });

  await signUp('a@b.com', 'secret', client);
  assert.deepEqual(calls[0], [{ email: 'a@b.com', password: 'secret' }]);

  const failing = makeFakeClient({ signUp: () => ({ data: {}, error: { message: 'User already registered' } }) });
  await assert.rejects(() => signUp('a@b.com', 'secret', failing), /注册失败/);
});

test('signOut 调用 auth.signOut，出错抛中文 Error', async () => {
  const calls: unknown[] = [];
  const client = makeFakeClient({
    signOut: (...args) => {
      calls.push(args);
      return { error: null };
    },
  });

  await signOut(client);
  assert.equal(calls.length, 1);

  const failing = makeFakeClient({ signOut: () => ({ error: { message: 'Session not found' } }) });
  await assert.rejects(() => signOut(failing), /登出失败/);
});

test('getCurrentUser 返回收敛后的 User；未登录返回 null；出错抛中文 Error', async () => {
  const client = makeFakeClient({
    getUser: () => ({ data: { user: { id: 'u1', email: 'a@b.com' } }, error: null }),
  });
  assert.deepEqual(await getCurrentUser(client), { id: 'u1', email: 'a@b.com' });

  const noUser = makeFakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
  assert.equal(await getCurrentUser(noUser), null);

  const failing = makeFakeClient({ getUser: () => ({ data: { user: null }, error: { message: 'not found' } }) });
  await assert.rejects(() => getCurrentUser(failing), /获取当前用户失败/);
});

test('onAuthChange 转发会话用户并返回取消订阅函数', () => {
  let unsubscribed = false;
  const listener: ((_event: string, session: unknown) => void)[] = [];
  const client = makeFakeClient({
    onAuthStateChange: (...args: unknown[]) => {
      const cb = args[0] as (_event: string, session: unknown) => void;
      listener.push(cb);
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              unsubscribed = true;
            },
          },
        },
      };
    },
  });

  const seen: unknown[] = [];
  const unsub = onAuthChange((u) => seen.push(u), client);

  // 模拟带会话的回调
  listener[0]('SIGNED_IN', { user: { id: 'u1', email: 'a@b.com' } });
  assert.deepEqual(seen[0], { id: 'u1', email: 'a@b.com' });

  // 模拟登出（无会话）
  listener[0]('SIGNED_OUT', null);
  assert.equal(seen[1], null);

  unsub();
  assert.equal(unsubscribed, true, '取消订阅应透传到底层 unsubscribe');
});
