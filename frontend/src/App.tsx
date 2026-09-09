import { useCallback, useEffect, useState } from 'react';
import { getCurrentUser, onAuthChange, signOut, type AuthUser } from './auth';
import { AuthForm } from './AuthForm';
import { WorldView } from './WorldView';
import './theme.css';

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
    <>
      {!loading && user === null && <AuthForm />}
      {user !== null && <WorldView user={user} onLogout={handleLogout} />}
      {loading && user === null && (
        <main className="mg-gradient" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
          <p className="mg-title">正在读取存档…</p>
        </main>
      )}
      {error && !loading && user === null && (
        <div
          role="alert"
          className="mg-fade-in"
          style={{
            position: 'fixed',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(224,82,82,0.15)',
            border: '1px solid rgba(224,82,82,0.5)',
            color: 'var(--mg-red)',
            padding: '6px 16px',
            borderRadius: 999,
            fontSize: 13,
            zIndex: 50,
          }}
        >
          {error}
        </div>
      )}
    </>
  );
}

export default App;
