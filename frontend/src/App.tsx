import { useCallback, useEffect, useState } from 'react';
import type { UserProfile } from '@mygame/shared';
import { apiLogout, apiMe } from './api';
import { AuthForm } from './AuthForm';
import { WorldView } from './WorldView';

const TOKEN_KEY = 'mygame_token';

function readToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function App() {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [user, setUser] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(token !== null);

  // 有 token 时拉取用户档案（会话持久：刷新页面后仍保持登录）
  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiMe(token)
      .then((u) => {
        if (cancelled) {
          return;
        }
        setUser(u);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        // token 失效或网络异常：清除本地会话，回到登录页
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAuth = useCallback((newToken: string, newUser: UserProfile) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
    setUser(newUser);
    setError(null);
  }, []);

  const handleLogout = useCallback(() => {
    if (token) {
      apiLogout(token).catch(() => {
        // 登出失败不阻塞本地退出
      });
    }
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, [token]);

  // 招募等业务会改变用户档案（资源/部队），提升到 App 以驱动各卡片实时刷新
  const handleUserUpdate = useCallback((newUser: UserProfile) => {
    setUser(newUser);
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 720 }}>
      <h1>MyGame — 运筹帷幄</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {token === null && <AuthForm onAuth={handleAuth} />}
      {token !== null && loading && <p>正在读取存档…</p>}
      {token !== null && !loading && user !== null && (
        <WorldView user={user} token={token} onLogout={handleLogout} onUserUpdate={handleUserUpdate} />
      )}
    </main>
  );
}

export default App;