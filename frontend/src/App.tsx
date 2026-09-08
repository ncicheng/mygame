import { useCallback, useEffect, useState } from 'react';
import { getCurrentUser, onAuthChange, signOut, type AuthUser } from './auth';
import { AuthForm } from './AuthForm';
import { WorldView } from './WorldView';

function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 恢复会话 + 订阅认证状态变化（Supabase 自己管理 token，无需手动存储）
  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((u) => {
        if (cancelled) {
          return;
        }
        setUser(u);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    // 登录/注册/登出后回调收敛为 AuthUser（null = 未登录）
    const unsub = onAuthChange((u) => {
      setUser(u);
      setError(null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await signOut();
    } catch {
      // 登出失败不阻塞本地退出
    }
    setUser(null);
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720 }}>
      <h1>MyGame — 运筹帷幄</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {loading && user === null && <p>正在读取存档…</p>}
      {!loading && user === null && <AuthForm />}
      {user !== null && <WorldView user={user} onLogout={handleLogout} />}
    </main>
  );
}

export default App;
