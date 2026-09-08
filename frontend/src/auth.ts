import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** 应用内使用的用户视图：只暴露 id 与可选 email */
export type AuthUser = { id: string; email?: string };

/** 注册：新建账号。出错时抛带中文 message 的 Error。
 * 可选 client 参数便于测试注入假客户端。 */
export async function signUp(
  email: string,
  password: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`注册失败：${error.message}`);
}

/** 登录：校验邮箱密码建立会话。出错时抛带中文 message 的 Error。 */
export async function signIn(
  email: string,
  password: string,
  client: SupabaseClient = supabase,
): Promise<void> {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`登录失败：${error.message}`);
}

/** 登出：结束当前会话。出错时抛带中文 message 的 Error。 */
export async function signOut(client: SupabaseClient = supabase): Promise<void> {
  const { error } = await client.auth.signOut();
  if (error) throw new Error(`登出失败：${error.message}`);
}

/** 获取当前登录用户；未登录返回 null。出错时抛带中文 message 的 Error。 */
export async function getCurrentUser(client: SupabaseClient = supabase): Promise<AuthUser | null> {
  const { data, error } = await client.auth.getUser();
  if (error) throw new Error(`获取当前用户失败：${error.message}`);
  const user = data?.user;
  if (!user) return null;
  return { id: user.id, email: user.email ?? undefined };
}

/** 监听登录状态变化，回调收到收敛后的 AuthUser（未登录为 null）；返回取消订阅函数。 */
export function onAuthChange(
  cb: (user: AuthUser | null) => void,
  client: SupabaseClient = supabase,
): () => void {
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    const user = session?.user;
    cb(user ? { id: user.id, email: user.email ?? undefined } : null);
  });
  return () => data.subscription.unsubscribe();
}
