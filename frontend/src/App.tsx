import { useCallback, useEffect, useState } from 'react';
import { getCurrentUser, onAuthChange, signOut, type AuthUser } from './auth';
import { fetchIsAdmin } from './data';
import { AuthForm } from './AuthForm';
import { WorldView } from './WorldView';
import { AdminPage } from './AdminPage';
import { Tutorial } from './Tutorial';
import { CopyrightFooter } from './CopyrightFooter';
import './theme.css';

function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 后台管理页开关：管理员点「后台」进入，返回后关闭
  const [showAdmin, setShowAdmin] = useState(false);

  // 根据当前用户刷新管理员状态（未登录则置为 false）
  const refreshIsAdmin = useCallback((u: AuthUser | null) => {
    if (!u) {
      setIsAdmin(false);
      return;
    }
    fetchIsAdmin(u.id)
      .then(setIsAdmin)
      .catch(() => {
        // 读取失败不阻塞主流程，后台入口保持隐藏
        setIsAdmin(false);
      });
  }, []);

  // 恢复会话 + 订阅认证状态变化（Supabase 自己管理 token，无需手动存储）
  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((u) => {
        if (cancelled) {
          return;
        }
        setUser(u);
        refreshIsAdmin(u);
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
      refreshIsAdmin(u);
      setError(null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [refreshIsAdmin]);

  const handleLogout = useCallback(async () => {
    try {
      await signOut();
    } catch {
      // 登出失败不阻塞本地退出
    }
    setUser(null);
    setIsAdmin(false);
    setShowAdmin(false);
  }, []);

  // 首次登录展示新手引导：本地标记未完成则显示覆盖层，完成后写入 localStorage
  const [tutorialDone, setTutorialDone] = useState<boolean>(
    () => localStorage.getItem('mygame_tutorial_done') === '1',
  );
  const handleTutorialClose = useCallback(() => {
    localStorage.setItem('mygame_tutorial_done', '1');
    setTutorialDone(true);
  }, []);

  return (
    <>
      {!loading && user === null && <AuthForm />}
      {user !== null &&
        (showAdmin ? (
          <AdminPage onClose={() => setShowAdmin(false)} />
        ) : (
          <WorldView user={user} isAdmin={isAdmin} onLogout={handleLogout} onOpenAdmin={() => setShowAdmin(true)} />
        ))}
      {user !== null && !tutorialDone && <Tutorial onClose={handleTutorialClose} />}
      {loading && user === null && (
        <main className="mg-gradient" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
          <p className="mg-title">正在读取存档…</p>
        </main>
      )}
      {loading && user === null && <CopyrightFooter />}
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
      {error && !loading && user === null && <CopyrightFooter />}
    </>
  );
}

export default App;
