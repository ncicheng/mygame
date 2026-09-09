import { useState } from 'react';
import type { BattleReport, Resources } from '@mygame/shared';
import type { QuestState } from './quests';
import type { Guild, GuildMember } from './data';

interface RightColumnProps {
  resources: Resources | null;
  reports: BattleReport[];
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
  resources,
  reports,
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
              {myGuild.leaderUserId && (
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
            <div className="trow">
              <button
                type="button"
                className="mg-btn ghost"
                onClick={() => onLeaveGuild(myGuild.id)}
              >
                退出军团
              </button>
            </div>
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
