import { useEffect, useMemo, useState } from 'react';
import { BATTLE_ROUNDS, type BattleReport } from '@mygame/shared';

interface BattleOverlayProps {
  report: BattleReport;
  onClose(): void;
}

/** 播放速度倍率选项 */
const SPEEDS = [1, 2, 4] as const;

/**
 * 战斗实例 UI（变体 C 指挥台）：战前布阵 + 自动播放（可加速） + 武将技能窗口 + 战报。
 * 战斗由服务器权威结算，此界面负责对已结算的战斗日志做过程回放与结果展示。
 */
export function BattleOverlay({ report, onClose }: BattleOverlayProps) {
  const { log } = report;
  const [speed, setSpeed] = useState<number>(1);
  const [round, setRound] = useState(0);
  const [playing, setPlaying] = useState(true);

  const rounds = useMemo(() => log.rounds, [log.rounds]);
  const totalRounds = BATTLE_ROUNDS;

  // 自动播放：按回合推进，速度倍率控制节奏
  useEffect(() => {
    if (!playing) {
      return;
    }
    if (round >= totalRounds) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setRound((r) => Math.min(totalRounds, r + 1)), 900 / speed);
    return () => clearTimeout(id);
  }, [playing, round, speed, totalRounds]);

  const current = rounds[Math.min(round, rounds.length - 1)];

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal battle-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>⚔ 战斗实例 · {report.wildlandName}</b>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </header>

        {/* 结果横幅 */}
        <div className={`battle-banner ${report.victory ? 'win' : 'lose'}`}>
          {report.victory ? '🏆 大捷！' : '💀 战败'}
          {report.victory && report.droppedRare > 0 && (
            <span className="drop">+{report.droppedRare} 稀有材料</span>
          )}
        </div>

        {/* 战前布阵：双方战力对比 */}
        <div className="battle-formation">
          <div className="side">
            <b>{report.generalName}</b>
            <span>战力 {log.attacker.power}</span>
            <span>兵力 {log.attacker.troopCount}</span>
          </div>
          <div className="vs">VS</div>
          <div className="side enemy">
            <b>{report.wildlandName}</b>
            <span>战力 {log.defender.power}</span>
            <span>兵力 {log.defender.troopCount}</span>
          </div>
        </div>

        {/* 战斗过程：按回合自动推进 */}
        <div className="battle-play">
          <div className="battle-roundline">
            <div className="pbar-a" style={{ width: `${log.attacker.survivors / Math.max(1, log.attacker.troopCount) * 100}%` }} />
            <div className="pbar-d" style={{ width: `${log.defender.survivors / Math.max(1, log.defender.troopCount) * 100}%` }} />
          </div>
          <div className="battle-rounds">
            <div className="r">第 {Math.min(round, totalRounds)} / {totalRounds} 回合</div>
            <div className="r">
              我方剩 <b>{current?.attackerSurvivors ?? 0}</b> · 敌方剩 <b>{current?.defenderSurvivors ?? 0}</b>
            </div>
          </div>
          <div className="battle-controls">
            <button type="button" className="act kind" onClick={() => setPlaying((p) => !p)}>
              {playing ? '暂停' : '继续'}
            </button>
            <button type="button" className="act kind" onClick={() => setRound(0)}>
              重播
            </button>
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={`act kind${speed === s ? ' act-on' : ''}`}
                onClick={() => setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        {/* 武将技能窗口 */}
        <div className="battle-skill">
          <span>🎯 技能窗口</span>
          <button type="button" className="act kind" disabled>
            威吓（战前已自动释放）
          </button>
          <span className="hint">MVP 阶段武将技能由服务器在结算时生效，此处展示已用技能。</span>
        </div>

        {/* 战报明细 */}
        <div className="battle-report">
          <div className="trow">
            <span>我方战损</span>
            <span className="n">-{report.attackerCasualties} 兵</span>
          </div>
          <div className="trow">
            <span>敌方战损</span>
            <span className="n">-{report.defenderCasualties} 兵</span>
          </div>
          {report.victory && (
            <div className="trow">
              <span>稀有材料掉落</span>
              <span className="n">+{report.droppedRare}</span>
            </div>
          )}
          <div className="trow">
            <span>时间</span>
            <span>{new Date(report.createdAt).toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
