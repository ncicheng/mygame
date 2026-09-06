import { useState, type FormEvent } from 'react';
import type { UserProfile } from '@mygame/shared';
import { ApiError, apiLogin, apiRegister } from './api';

interface AuthFormProps {
  onAuth(token: string, user: UserProfile): void;
}

/** 登录/注册表单：新注册自动领取初始武将与资源 */
export function AuthForm({ onAuth }: AuthFormProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token, user } =
        mode === 'login' ? await apiLogin(username, password) : await apiRegister(username, password);
      onAuth(token, user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'grid', gap: '0.75rem', maxWidth: 320 }}>
      <h2>{mode === 'login' ? '登录' : '注册'}</h2>
      <label>
        用户名
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          style={{ display: 'block', marginTop: 4 }}
        />
      </label>
      <label>
        密码
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          style={{ display: 'block', marginTop: 4 }}
        />
      </label>
      {error && <p style={{ color: 'crimson', margin: 0 }}>{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并领取初始武将'}
      </button>
      <button
        type="button"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setError(null);
        }}
      >
        {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
      </button>
    </form>
  );
}