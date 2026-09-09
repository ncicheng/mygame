import type { BattleReport, Resources } from '@mygame/shared';
import type { QuestState } from './quests';

interface RightColumnProps {
  resources: Resources | null;
  reports: BattleReport[];
  quests: QuestState;
  /** 点击某条战报时打开战斗回放 */
  onOpenReport(report: BattleReport): void;
}

/** 右卡片栏：资源卡 + 战报卡 + 任务卡 + 军团卡 */
export function RightColumn({ resources, reports, quests, onOpenReport }: RightColumnProps) {
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
        <div className="trow"><span>敬请期待（后续迭代）</span></div>
      </section>
    </>
  );
}
