import { useState, type FormEvent } from 'react';
import { signIn, signUp } from './auth';
import { CopyrightFooter } from './CopyrightFooter';

/* 简单的线性同余生成器：确定性生成星野坐标，避免每次渲染抖动 */
function makeStars(count: number): { x: number; y: number; size: number; delay: number; dur: number }[] {
  const out = [];
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    out.push({
      x: rand() * 100,
      y: rand() * 100,
      size: 1 + rand() * 2,
      delay: rand() * 4,
      dur: 2 + rand() * 4,
    });
  }
  return out;
}

const STARS = makeStars(45);

/** 登录/注册表单：全屏星野背景 + 毛玻璃卡片 + 版权标识，成功后由 onAuthChange 自动推进 */
export function AuthForm() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
      // 成功后 App 的 onAuthChange 会收到新会话，无需在此更新状态
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mg-gradient" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 动态星野 + 水墨光晕装饰 */}
      <div className="mg-backdrop" aria-hidden="true">
        {STARS.map((s, i) => (
          <span
            key={i}
            className="star"
            style={{
              left: `${s.x}%`,
              top: `${s.y}%`,
              width: s.size,
              height: s.size,
              animationDelay: `${s.delay}s`,
              animationDuration: `${s.dur}s`,
            }}
          />
        ))}
        <span
          className="orb"
          style={{ left: '-10%', top: '-10%', width: 380, height: 380, background: 'rgba(47,212,176,0.5)' }}
        />
        <span
          className="orb"
          style={{ right: '-8%', bottom: '-8%', width: 420, height: 420, background: 'rgba(240,180,41,0.45)' }}
        />
      </div>

      <main
        className="mg-slide-up"
        style={{ flex: 1, display: 'grid', placeItems: 'center', position: 'relative', zIndex: 1, padding: '1rem' }}
      >
        <form
          onSubmit={handleSubmit}
          className="mg-card mg-fade-in"
          style={{ display: 'grid', gap: '0.75rem', maxWidth: 340, width: '100%', padding: '1.5rem' }}
        >
          <h2 className="mg-title" style={{ fontSize: 20, margin: '0 0 4px', textAlign: 'center' }}>
            MyGame · 运筹帷幄
          </h2>
          <p className="mg-accent" style={{ margin: '0 0 8px', textAlign: 'center', fontSize: 13, letterSpacing: 1 }}>
            {mode === 'login' ? '欢迎归来，主公' : '厉兵秣马，招贤纳士'}
          </p>
          <label style={{ fontSize: 13, color: 'var(--mg-text-dim)', display: 'grid', gap: 4 }}>
            邮箱
            <input
              className="mg-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              type="email"
              required
            />
          </label>
          <label style={{ fontSize: 13, color: 'var(--mg-text-dim)', display: 'grid', gap: 4 }}>
            密码
            <input
              className="mg-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </label>
          {error && <p style={{ color: 'var(--mg-red)', margin: 0, fontSize: 13 }}>{error}</p>}
          <button className="mg-btn" type="submit" disabled={busy}>
            {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
          </button>
          <button
            className="mg-btn ghost"
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
          </button>
        </form>
      </main>

      <div style={{ position: 'relative', zIndex: 1 }}>
        <CopyrightFooter />
      </div>
    </div>
  );
}
