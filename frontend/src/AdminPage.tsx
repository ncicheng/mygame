import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  adminAddGuildMember,
  adminAdjustResources,
  adminDeleteGuild,
  adminDeleteUser,
  adminGetParams,
  adminKickGuildMember,
  adminListGuilds,
  adminListUsers,
  adminRenameGuild,
  adminSetActionPoints,
  adminSetAdmin,
  adminSetGeneral,
  adminSetNickname,
  adminSetParam,
  adminSetPeaceProtection,
  adminSetTroopUnlock,
  adminSetWeaponTier,
} from './data';
import type { AdminGuild } from './data';

// admin_list_users 返回的单行结构（字段与 schema.sql 的 admin_list_users 一致）
interface AdminUserRow {
  id: string;
  email: string | null;
  nickname: string | null;
  is_admin: boolean;
  general_level: number | null;
  general_stars: number | null;
  weapon_tier: number | null;
  food: number | null;
  iron: number | null;
  rare: number | null;
  gold: number | null;
  troop_max_unlocked: number | null;
}

/** 后台管理页 Props。 */
interface AdminPageProps {
  onClose(): void;
}

/** 通用行内编辑字段：标签 + 输入框 + 按钮。 */
interface FieldInputProps {
  label: string;
  value: string;
  placeholder?: string;
  onChange(v: string): void;
  onSubmit(): void;
  disabled?: boolean;
}

/** 单个行内编辑字段（输入框 + 提交按钮）。 */
function FieldInput({ label, value, placeholder, onChange, onSubmit, disabled }: FieldInputProps) {
  return (
    <label className="admin-field">
      <span>{label}</span>
      <span className="admin-field-row">
        <input
          type="text"
          className="mg-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
          }}
        />
        <button type="button" className="mg-btn" onClick={onSubmit} disabled={disabled}>
          设置
        </button>
      </span>
    </label>
  );
}

/** 用户行编辑卡片：各操作独立输入 + 调用 admin 函数后刷新列表，行内展示成功/失败。 */
function UserRow({ user, onChanged }: { user: AdminUserRow; onChanged(): void }) {
  // 武将等级/星级
  const [level, setLevel] = useState(String(user.general_level ?? 1));
  const [stars, setStars] = useState(String(user.general_stars ?? 1));
  // 武器阶
  const [weaponTier, setWeaponTier] = useState(String(user.weapon_tier ?? 1));
  // 兵种解锁
  const [troopUnlock, setTroopUnlock] = useState(String(user.troop_max_unlocked ?? 1));
  // 资源增量（delta，可负）
  const [foodDelta, setFoodDelta] = useState('0');
  const [ironDelta, setIronDelta] = useState('0');
  const [rareDelta, setRareDelta] = useState('0');
  const [goldDelta, setGoldDelta] = useState('0');
  // 昵称
  const [nickname, setNickname] = useState(user.nickname ?? '');
  // 免战期（小时；空表示不操作）
  const [peaceHours, setPeaceHours] = useState('');
  // 行动点数（空表示不操作）
  const [actionPoints, setActionPoints] = useState('');
  // 反馈
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 解析整数输入；空串或非法 → 0
  const toInt = (v: string): number => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
  };

  // 统一执行某管理操作：成功刷新列表，失败显示行内错误
  const run = useCallback(
    async (action: () => Promise<void>, okText: string) => {
      setBusy(true);
      setErr(null);
      try {
        await action();
        setMsg(okText);
        onChanged();
      } catch (e) {
        setMsg(null);
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const num = (v: number | null) => (v == null ? '—' : v);

  return (
    <div className="admin-user-card mg-card">
      <div className="admin-user-head">
        <span className="admin-user-name">
          {user.nickname || user.email || '未命名用户'}
          {user.is_admin && <span className="admin-badge">管理员</span>}
        </span>
        <span className="admin-user-id">id: {user.id}</span>
        <button
          type="button"
          className="mg-btn ghost"
          disabled={busy}
          onClick={() =>
            void run(() => adminSetAdmin(user.id, !user.is_admin), `已${user.is_admin ? '撤销' : '授予'}管理员`)
          }
        >
          {user.is_admin ? '撤销管理员' : '设为管理员'}
        </button>
      </div>

      <div className="admin-user-overview">
        <span>邮箱：{user.email ?? '—'}</span>
        <span>武将：Lv.{num(user.general_level)} 星{num(user.general_stars)}</span>
        <span>武器阶：{num(user.weapon_tier)}</span>
        <span>兵种解锁：Lv.{num(user.troop_max_unlocked)}</span>
        <span>
          资源：粮{num(user.food)} 铁{num(user.iron)} 稀{num(user.rare)} 金{num(user.gold)}
        </span>
      </div>

      <div className="admin-edit-grid">
        <FieldInput label="武将等级" value={level} onChange={setLevel} disabled={busy}
          onSubmit={() => void run(() => adminSetGeneral(user.id, toInt(level), toInt(stars)), '已设置武将等级/星级')} />
        <FieldInput label="武将星级" value={stars} onChange={setStars} disabled={busy}
          onSubmit={() => void run(() => adminSetGeneral(user.id, toInt(level), toInt(stars)), '已设置武将等级/星级')} />
        <FieldInput label="武器阶" value={weaponTier} onChange={setWeaponTier} disabled={busy}
          onSubmit={() => void run(() => adminSetWeaponTier(user.id, toInt(weaponTier)), '已设置武器阶')} />
        <FieldInput label="兵种解锁" value={troopUnlock} onChange={setTroopUnlock} disabled={busy}
          onSubmit={() => void run(() => adminSetTroopUnlock(user.id, toInt(troopUnlock)), '已设置兵种解锁')} />
        <FieldInput label="昵称" value={nickname} onChange={setNickname} disabled={busy}
          onSubmit={() => void run(() => adminSetNickname(user.id, nickname), '已修改昵称')} />
      </div>

      <div className="admin-resource-adjust">
        <span className="admin-resource-label">资源增量：</span>
        <input type="text" className="mg-input" value={foodDelta} placeholder="粮" onChange={(e) => setFoodDelta(e.target.value)} />
        <input type="text" className="mg-input" value={ironDelta} placeholder="铁" onChange={(e) => setIronDelta(e.target.value)} />
        <input type="text" className="mg-input" value={rareDelta} placeholder="稀" onChange={(e) => setRareDelta(e.target.value)} />
        <input type="text" className="mg-input" value={goldDelta} placeholder="金" onChange={(e) => setGoldDelta(e.target.value)} />
        <button
          type="button"
          className="mg-btn"
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                adminAdjustResources(user.id, toInt(foodDelta), toInt(ironDelta), toInt(rareDelta), toInt(goldDelta)),
              '已调整资源',
            )
          }
        >
          调整资源
        </button>
      </div>

      <div className="admin-edit-grid">
        <FieldInput
          label="免战期(小时)"
          value={peaceHours}
          placeholder="0 立即结束"
          onChange={setPeaceHours}
          disabled={busy}
          onSubmit={() => {
            if (peaceHours.trim() === '') return;
            void run(() => adminSetPeaceProtection(user.id, toInt(peaceHours)), `已设置免战期 ${toInt(peaceHours)} 小时`);
          }}
        />
        <FieldInput
          label="行动点数"
          value={actionPoints}
          placeholder="如 5"
          onChange={setActionPoints}
          disabled={busy}
          onSubmit={() => {
            if (actionPoints.trim() === '') return;
            void run(() => adminSetActionPoints(user.id, toInt(actionPoints)), `已重置行动点为 ${toInt(actionPoints)}`);
          }}
        />
      </div>

      <div className="admin-danger">
        <button
          type="button"
          className="mg-btn danger"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`确认删除用户「${user.nickname || user.email || user.id}」？此操作不可恢复！`)) return;
            void run(() => adminDeleteUser(user.id), '已删除用户');
          }}
        >
          删除用户
        </button>
      </div>

      {msg && <div className="admin-feedback ok">{msg}</div>}
      {err && <div className="admin-feedback err">{err}</div>}
    </div>
  );
}

/** 可设置的游戏参数目录（key → 展示信息）。新增玩法参数时在此登记即可出现在面板。 */
const KNOWN_PARAMS: { key: string; label: string; hint: string; default: string }[] = [
  {
    key: 'peace_duration_hours',
    label: '新用户免战期（小时）',
    hint: '新注册玩家默认免战时长，0 表示不设免战',
    default: '24',
  },
];

/** 参数面板：列出全部可设置参数（含当前值/默认值），可编辑保存；不提供新增任意键。 */
function ParamsPanel({ params, onChanged }: { params: Record<string, unknown>; onChanged(): void }) {
  // 面板要展示的参数项：目录中登记的 + 库里已存在但未登记的其他键（避免隐藏已有数据）
  const entries = useMemo(() => {
    const known = KNOWN_PARAMS.map((p) => ({
      key: p.key,
      label: p.label,
      hint: p.hint,
      value: params[p.key] != null ? String(params[p.key]) : p.default,
    }));
    const extra = Object.keys(params)
      .filter((k) => !KNOWN_PARAMS.some((p) => p.key === k))
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({ key: k, label: k, hint: '未登记参数', value: String(params[k]) }));
    return [...known, ...extra];
  }, [params]);

  // key → 编辑中的值
  const [edits, setEdits] = useState<Record<string, string>>({});
  const setEdit = (key: string, value: string) => setEdits((prev) => ({ ...prev, [key]: value }));
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveParam = useCallback(
    async (key: string) => {
      setBusy(true);
      setErr(null);
      try {
        await adminSetParam(key, edits[key] ?? '');
        setMsg(`已保存参数「${key}」`);
        onChanged();
      } catch (e) {
        setMsg(null);
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [edits, onChanged],
  );

  return (
    <div className="admin-card mg-card">
      <h3 className="mg-title">参数面板</h3>
      <p className="admin-empty" style={{ fontSize: 12 }}>
        设置游戏可调参数，保存后对后续新玩家生效（如新用户免战期小时数）。
      </p>

      {entries.length === 0 ? (
        <p className="admin-empty">无可设置参数</p>
      ) : (
        <div className="admin-param-list">
          {entries.map((e) => (
            <div className="admin-param-row" key={e.key}>
              <div className="admin-param-meta">
                <span className="admin-param-key">{e.label}</span>
                <span className="hint">{e.hint}</span>
              </div>
              <input
                type="text"
                className="mg-input"
                value={edits[e.key] ?? e.value}
                placeholder={e.value}
                onChange={(v) => setEdit(e.key, v.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') void saveParam(e.key);
                }}
              />
              <button type="button" className="mg-btn" disabled={busy} onClick={() => void saveParam(e.key)}>
                保存
              </button>
            </div>
          ))}
        </div>
      )}

      {msg && <div className="admin-feedback ok">{msg}</div>}
      {err && <div className="admin-feedback err">{err}</div>}
    </div>
  );
}

/** 军团管理面板：列出全部军团（盟主/成员数/成员列表），支持成员增删、重命名与解散。 */
function GuildsPanel({ guilds, onChanged }: { guilds: AdminGuild[]; onChanged(): void }) {
  // 每行的重命名输入
  const [renames, setRenames] = useState<Record<string, string>>({});
  // 每行新增成员的 user_id 输入
  const [addIds, setAddIds] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<void>, okText: string) => {
      setBusy(true);
      setErr(null);
      try {
        await action();
        setMsg(okText);
        onChanged();
      } catch (e) {
        setMsg(null);
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return (
    <div className="admin-card mg-card">
      <h3 className="mg-title">军团管理（{guilds.length}）</h3>
      {guilds.length === 0 ? (
        <p className="admin-empty">暂无军团</p>
      ) : (
        <div className="admin-guild-list">
          {guilds.map((g) => (
            <div className="admin-guild-row" key={g.id}>
              <div className="admin-guild-info">
                <span className="admin-guild-name">{g.name}</span>
                <span className="hint">👑 {g.leaderNickname ?? g.leaderUserId}</span>
                <span className="hint">成员 {g.memberCount}</span>
              </div>

              <div className="admin-guild-members">
                {g.members.length === 0 ? (
                  <span className="hint">（暂无成员）</span>
                ) : (
                  g.members.map((m) => (
                    <span className="admin-guild-member" key={m.userId}>
                      {m.userId === g.leaderUserId ? '👑' : '⚔'} {m.nickname ?? m.userId}
                      {m.userId !== g.leaderUserId && (
                        <button
                          type="button"
                          className="mg-btn danger mini"
                          disabled={busy}
                          onClick={() => void run(() => adminKickGuildMember(g.id, m.userId), `已移除「${m.nickname ?? m.userId}」`)}
                        >
                          移出
                        </button>
                      )}
                    </span>
                  ))
                )}
              </div>

              <div className="admin-guild-actions">
                <input
                  type="text"
                  className="mg-input"
                  placeholder="新名称"
                  value={renames[g.id] ?? ''}
                  onChange={(e) => setRenames((prev) => ({ ...prev, [g.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (renames[g.id] ?? '').trim()) {
                      void run(() => adminRenameGuild(g.id, (renames[g.id] ?? '').trim()), `已重命名「${g.name}」`);
                    }
                  }}
                />
                <button
                  type="button"
                  className="mg-btn"
                  disabled={busy || !(renames[g.id] ?? '').trim()}
                  onClick={() => void run(() => adminRenameGuild(g.id, (renames[g.id] ?? '').trim()), `已重命名「${g.name}」`)}
                >
                  重命名
                </button>
                <input
                  type="text"
                  className="mg-input"
                  placeholder="添加成员 user_id"
                  value={addIds[g.id] ?? ''}
                  onChange={(e) => setAddIds((prev) => ({ ...prev, [g.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (addIds[g.id] ?? '').trim()) {
                      void run(() => adminAddGuildMember(g.id, (addIds[g.id] ?? '').trim()), '已添加成员');
                    }
                  }}
                />
                <button
                  type="button"
                  className="mg-btn"
                  disabled={busy || !(addIds[g.id] ?? '').trim()}
                  onClick={() => void run(() => adminAddGuildMember(g.id, (addIds[g.id] ?? '').trim()), '已添加成员')}
                >
                  添加成员
                </button>
                <button
                  type="button"
                  className="mg-btn danger"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`确认解散军团「${g.name}」？成员将全部退出！`)) return;
                    void run(() => adminDeleteGuild(g.id), `已解散「${g.name}」`);
                  }}
                >
                  解散
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {msg && <div className="admin-feedback ok">{msg}</div>}
      {err && <div className="admin-feedback err">{err}</div>}
    </div>
  );
}

/** 后台管理页：用户管理 + 参数面板。入口来自 WorldView 的「后台」按钮。 */
export function AdminPage({ onClose }: AdminPageProps) {
  // 所有 hooks 置于组件顶部、任何条件 return 之前，避免 hooks 顺序变化导致空白页
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [guilds, setGuilds] = useState<AdminGuild[]>([]);

  // 加载用户列表 + 游戏参数；失败进入错误态
  const load = useCallback(async () => {
    try {
      const [u, p, g] = await Promise.all([adminListUsers(), adminGetParams(), adminListGuilds()]);
      setUsers(u as unknown as AdminUserRow[]);
      setParams(p);
      setGuilds(g);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载即加载
  useEffect(() => {
    void load();
  }, [load]);

  // 刷新列表（编辑成功后调用）
  const handleChanged = useCallback(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <main className="admin-page mg-gradient">
        <div className="mg-title">正在加载后台数据…</div>
      </main>
    );
  }

  if (loadErr) {
    return (
      <main className="admin-page mg-gradient">
        <div className="admin-load-err">
          {loadErr}
          <button type="button" className="mg-btn ghost" onClick={() => void load()}>
            重试
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="admin-page mg-gradient">
      <header className="admin-top">
        <h1 className="mg-title">🎛️ 后台管理</h1>
        <button type="button" className="mg-btn ghost" onClick={onClose}>
          返回游戏
        </button>
      </header>

      <section className="admin-card mg-card">
        <h3 className="mg-title">用户管理（{users.length}）</h3>
        {users.length === 0 ? (
          <p className="admin-empty">暂无用户</p>
        ) : (
          <div className="admin-user-list">
            {users.map((u) => (
              <UserRow key={u.id} user={u} onChanged={handleChanged} />
            ))}
          </div>
        )}
      </section>

      <ParamsPanel params={params} onChanged={handleChanged} />
      <GuildsPanel guilds={guilds} onChanged={handleChanged} />
    </main>
  );
}
