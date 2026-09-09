import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// 防御式读取：非 Vite 运行时（如 node 单测）import.meta.env 可能未定义；
// 本地开发未配置 Supabase 时收敛为空串。
const url =
  (import.meta as unknown as { env?: { VITE_SUPABASE_URL?: string } }).env?.VITE_SUPABASE_URL ?? '';
const anon =
  (import.meta as unknown as { env?: { VITE_SUPABASE_ANON_KEY?: string } }).env
    ?.VITE_SUPABASE_ANON_KEY ?? '';

// createClient 在 url 为空时会抛错；本地开发未配置时不在此处初始化，
// 导出惰性占位对象以避免 import 即崩溃，待配置环境变量后自然可用。
export const supabase: SupabaseClient = url
  ? createClient(url, anon)
  : ({} as SupabaseClient);
