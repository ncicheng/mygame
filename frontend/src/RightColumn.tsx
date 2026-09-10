import { useState } from 'react';
import type { BattleReport, Resources } from '@mygame/shared';
import type { QuestState } from './quests';
import type { Challenge, Guild, GuildMember } from './data';

interface RightColumnProps {
  /** 当前玩家 id（用于判定盟主本人 / 控制退出按钮） */
  userId: string;
  resources: Resources | null;
  reports: BattleReport[];
  /** PvP 挑战列表（与本人相关的挑战，按时间倒序） */
  challenges: Challenge[];
  quests: QuestState;
  /** 点击某条战报时打开战斗回放 */
  onOpenReport(report: BattleReport): void;
  /** 当前玩家所属军团；null 表示未加入任何军团 */
  myGuild: Guild | null;
  /** 可加入的军团列表（无军团时展示） */
  guilds: Guild[];
  /** 已加入军团的成员列表 */
  members: GuildMember[];
  /** 创建军团 */
  onCreateGuild(name: string): void;
  /** 加入指定军团 */
  onJoinGuild(guildId: string): void;
  /** 退出指定军团 */
  onLeaveGuild(guildId: string): void;
}

/** 右卡片栏：资源卡 + 战报卡 + 任务卡 + 军团卡 */
export function RightColumn({
  userId,
  resources,
  reports,
  challenges,
  quests,
  onOpenReport,
  myGuild,
  guilds,
  members,
  onCreateGuild,
  onJoinGuild,
  onLeaveGuild,
}: RightColumnProps) {
  const res = resources ?? { food: 0, iron: 0, rare: 0, gold: 0 };
  return (
    <>
      <section className="card">
        <h4>🗺 资源</h4>
        <div className="trow"><span>粮草</span><span className="n">{res.food.toLocaleString()}</span></div>
        <div className="trow"><span>铁材</span><span className="n">{res.iron.toLocaleString()}</span></div>
        <div className="trow"><span>稀有材料</span><span className="n">{res.rare.toLocaleString()}</span></div>
        <div className="trow"><span>金币</span><span className="n">{res.gold.toLocaleString()}</span></div>
      </section>

      <section className="card">
        <h4>📜 战报</h4>
        {reports.length === 0 ? (
          <div className="trow"><span>暂无战报（攻打野地后生成）</span></div>
        ) : (
          reports.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`report-row ${r.victory ? 'ok' : 'bad'}`}
              onClick={() => onOpenReport(r)}
              title={`点击回放「${r.wildlandName}」战斗`}
            >
              <span>{r.victory ? '🏆' : '💀'} {r.wildlandName}</span>
              <span className="n">
                {r.victory && r.droppedRare > 0 ? `+${r.droppedRare}稀有` : '失败'}
              </span>
            </button>
          ))
        )}
      </section>

      <section className="card">
        <h4>⚔ 挑战</h4>
        {challenges.length === 0 ? (
          <div className="trow"><span>暂无挑战（选中敌方部队可发起）</span></div>
        ) : (
          challenges.slice(0, 8).map((c) => {
            const summary = challengeSummary(c, userId);
            return (
              <div className="trow" key={c.id}>
                <span className="challenge-info">
                  <span>{challengeBadge(c, userId)}</span>
                  {summary && <span className="hint">{summary}</span>}
                </span>
                <span className="n hint">{new Date(c.createdAt).toLocaleTimeString()}</span>
              </div>
            );
          })
        )}
      </section>

      <section className="card">
        <h4>🏆 任务</h4>
        {quests.allDone ? (
          <div className="trow"><span>🏆 成就达成</span></div>
        ) : (
          <>
            {quests.current && (
              <div className="trow">
                <span>当前目标：{quests.current.title}</span>
                <span className="hint">{quests.current.hint}</span>
              </div>
            )}
            {quests.quests.map((q) => (
              <div className="trow" key={q.id}>
                <span>{q.done ? '✅' : '○'} {q.title}</span>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="card">
        <h4>⛳ 军团</h4>
        {myGuild ? (
          <>
            <div className="trow">
              <span>军团名：{myGuild.name}</span>
              {myGuild.leaderUserId === userId && (
                <span className="hint">盟主</span>
              )}
            </div>
            <div className="trow">
              <span>成员（{members.length}）</span>
            </div>
            {members.map((m) => (
              <div className="trow" key={m.userId}>
                <span>{m.userId === myGuild.leaderUserId ? '👑' : '⚔'} {m.userId}</span>
              </div>
            ))}
            {myGuild.leaderUserId !== userId && (
              <div className="trow">
                <button
                  type="button"
                  className="mg-btn ghost"
                  onClick={() => onLeaveGuild(myGuild.id)}
                >
                  退出军团
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <GuildCreateForm onCreateGuild={onCreateGuild} />
            <div className="trow"><span>可加入的军团</span></div>
            {guilds.length === 0 ? (
              <div className="trow"><span>暂无其他军团</span></div>
            ) : (
              guilds.map((g) => (
                <div className="trow" key={g.id}>
                  <span>{g.name}</span>
                  <button
                    type="button"
                    className="mg-btn ghost"
                    onClick={() => onJoinGuild(g.id)}
                  >
                    加入
                  </button>
                </div>
              ))
            )}
          </>
        )}
      </section>
    </>
  );
}

/** 挑战徽标：按当前玩家视角把服务器 result（挑战者视角）映射为获胜/失败/平局文案。 */
function challengeBadge(c: Challenge, userId: string): string {
  const prefix = c.challengerUserId === userId ? '发起' : '应战';
  // 未结算（pending / result 为空）显示「待结算」，避免误判为失败
  if (c.status !== 'resolved' || !c.result) return `${prefix} · 待结算`;
  // result 相对挑战者：我是挑战者时直读，我是被挑战者时取反
  let perspective: string;
  if (c.challengerUserId === userId) {
    perspective = c.result;
  } else if (c.result === 'draw') {
    perspective = 'draw';
  } else {
    perspective = c.result === 'challenger_win' ? 'challenger_lose' : 'challenger_win';
  }
  if (perspective === 'draw') return `${prefix} · 平局`;
  return `${prefix} · ${perspective === 'challenger_win' ? '挑战获胜' : '挑战失败'}`;
}

/** 从 result_summary 提取当前玩家视角的战力/战损摘要文案；无摘要返回 null。 */
function challengeSummary(c: Challenge, userId: string): string | null {
  if (c.status !== 'resolved' || !c.resultSummary) return null;
  const s = c.resultSummary as {
    attacker?: { power?: number; casualties?: number };
    defender?: { power?: number; casualties?: number };
  };
  const attacker = s.attacker;
  const defender = s.defender;
  if (!attacker || !defender) return null;
  const iAmChallenger = c.challengerUserId === userId;
  const myPower = iAmChallenger ? attacker.power : defender.power;
  const theirPower = iAmChallenger ? defender.power : attacker.power;
  const myCasualties = iAmChallenger ? attacker.casualties : defender.casualties;
  const theirCasualties = iAmChallenger ? defender.casualties : attacker.casualties;
  return `战力 ${myPower ?? 0} vs ${theirPower ?? 0} · 我方战损 ${myCasualties ?? 0} / 对方战损 ${theirCasualties ?? 0}`;
}

/** 创建军团的表单：输入名称 + 提交按钮。 */
function GuildCreateForm({ onCreateGuild }: { onCreateGuild(name: string): void }) {
  const [name, setName] = useState('');
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreateGuild(trimmed);
    setName('');
  };
  return (
    <div className="trow">
      <input
        className="mg-input"
        placeholder="输入军团名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button type="button" className="mg-btn ghost" onClick={submit}>
        创建军团
      </button>
    </div>
  );
}
