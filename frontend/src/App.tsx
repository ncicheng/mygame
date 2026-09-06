import { useEffect, useState } from 'react';
import type { HealthResponse } from '@mygame/shared';

// 生产环境（GitHub Pages）通过构建时注入 VITE_API_BASE_URL 指向后端地址；
// 开发环境由 Vite 代理 /api 到本地后端，留空即可。
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/health`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json() as Promise<HealthResponse>;
      })
      .then((body) => {
        if (!cancelled) {
          setHealth(body);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 640 }}>
      <h1>MyGame — 运筹帷幄</h1>
      <p style={{ color: '#666' }}>多人在线实时策略对战（脚手架 v0.1）</p>
      <section>
        <h2>后端健康检查</h2>
        {error && <p style={{ color: 'crimson' }}>无法连接后端：{error}</p>}
        {!error && !health && <p>正在检查后端连接…</p>}
        {health && (
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 1rem' }}>
            <dt>状态</dt>
            <dd>{health.status}</dd>
            <dt>数据库</dt>
            <dd>{health.db === 'connected' ? '已连接' : '未连接'}</dd>
            <dt>运行时长</dt>
            <dd>{Math.round(health.uptime)}s</dd>
            <dt>时间戳</dt>
            <dd>{new Date(health.timestamp).toLocaleString()}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}

export default App;