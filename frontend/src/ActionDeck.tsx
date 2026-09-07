import { useState } from 'react';
import { ACTION_COSTS, type ActionPoints } from '@mygame/shared';

interface ActionDeckProps {
  ap: ActionPoints;
  /** 点击招募按钮时打开招募弹窗（任务 4 接入） */
  onRecruit(): void;
}

interface DeckAction {
  key: string;
  label: string;
  cost: number;
  kind: boolean;
  hint: string;
}

/** 底部操作台动作表：消耗规则与任务开放时间（Task 4-7 逐步接通） */
const ACTIONS: readonly DeckAction[] = [
  { key: 'march', label: '出征', cost: ACTION_COSTS.march, kind: false, hint: '「出征」行军将在任务 5 开放' },
  { key: 'recruit', label: '招募', cost: ACTION_COSTS.recruit, kind: true, hint: '消耗基础资源与行动点，为武将补充兵卒' },
  { key: 'bandit', label: '打野', cost: ACTION_COSTS.bandit, kind: true, hint: '「打野」将在任务 6 开放' },
  { key: 'challenge', label: '挑战', cost: 0, kind: true, hint: '「挑战」对战将在后续迭代开放' },
  { key: 'siege', label: '攻城', cost: ACTION_COSTS.siege, kind: true, hint: '「攻城」军团战将在后续迭代开放' },
];

/** 底部行动点操作台：展示各操作消耗，行动点不足时置灰 */
export function ActionDeck({ ap, onRecruit }: ActionDeckProps) {
  const [hint, setHint] = useState<string | null>(null);
  return (
    <>
      {ACTIONS.map((action) => (
        <button
          key={action.key}
          type="button"
          className={`act${action.kind ? ' kind' : ''}`}
          disabled={action.cost > ap.current}
          onClick={() => {
            if (action.key === 'recruit') {
              onRecruit();
            } else {
              setHint(action.hint);
            }
          }}
        >
          {action.label}
          {action.cost > 0 && <span className="cost">{action.cost} 行动点</span>}
        </button>
      ))}
      <span className="apnote">{hint ?? '行动点每 10 分钟恢复 1 点'}</span>
    </>
  );
}