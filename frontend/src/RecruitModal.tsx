import { useState } from 'react';
import {
  ACTION_COSTS,
  TROOP_CATALOG,
  getTroopType,
  type ActionPoints,
  type Resources,
  type UserProfile,
} from '@mygame/shared';
import { apiRecruit } from './api';

interface RecruitModalProps {
  user: UserProfile;
  token: string;
  /** 当前行动点（不足 1 点时全部兵种置灰） */
  ap: number;
  onClose(): void;
  /** 招募成功：返回更新后的档案与行动点，由上层刷新卡片 */
  onRecruited(user: UserProfile, actionPoints: ActionPoints): void;
}

/** 招募弹窗：兵种表 + 数量步进 + 单兵成本 + 部队现有数量，逐行可招募 */
export function RecruitModal({ user, token, ap, onClose, onRecruited }: RecruitModalProps) {
  const general = user.generals[0];
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const doRecruit = async (soldierLevel: number) => {
    if (!general || busy) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiRecruit(token, { generalId: general.id, soldierLevel, count });
      onRecruited(res.user, res.actionPoints);
      setMessage(`已招募 ${count} 名 ${getTroopType(soldierLevel)?.name ?? '兵卒'}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const { food, iron, gold } = user.resources;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>⚒ 招募士兵</b>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="recruit-count">
          招募数量
          <button type="button" onClick={() => setCount((c) => Math.max(1, c - 1))}>
            −
          </button>
          <span>{count}</span>
          <button type="button" onClick={() => setCount((c) => c + 1)}>
            +
          </button>
        </div>

        {message && <div className="recruit-msg">{message}</div>}

        <table className="recruit-table">
          <thead>
            <tr>
              <th>等级</th>
              <th>兵种</th>
              <th>战力</th>
              <th>单兵成本</th>
              <th>部队已有</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {TROOP_CATALOG.map((t) => {
              const locked = t.level > user.troopMaxUnlocked;
              const owned = general?.army.find((u) => u.soldierLevel === t.level)?.count ?? 0;
              const totalCost: Resources = {
                food: t.cost.food * count,
                iron: t.cost.iron * count,
                gold: t.cost.gold * count,
                rare: 0,
              };
              const affordable = food >= totalCost.food && iron >= totalCost.iron && gold >= totalCost.gold;
              const disabled = busy || !general || locked || !affordable || ap < ACTION_COSTS.recruit;
              return (
                <tr key={t.level}>
                  <td>{t.level}</td>
                  <td>{locked ? `${t.name} 🔒` : t.name}</td>
                  <td>{t.power}</td>
                  <td className="n">
                    {locked
                      ? '未解锁'
                      : `粮 ${t.cost.food.toLocaleString()}
                    ${t.cost.iron > 0 ? ` 铁 ${t.cost.iron.toLocaleString()}` : ''}
                    ${t.cost.gold > 0 ? ` 金 ${t.cost.gold.toLocaleString()}` : ''}`}
                  </td>
                  <td>×{owned.toLocaleString()}</td>
                  <td>
                    <button type="button" disabled={disabled} onClick={() => doRecruit(t.level)}>
                      {locked ? '需解锁' : '招募'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}