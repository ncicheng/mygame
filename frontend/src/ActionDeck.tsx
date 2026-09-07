import { useState } from 'react';
import { ACTION_COSTS, type ActionPoints } from '@mygame/shared';

interface ActionDeckProps {
  ap: ActionPoints;
  /** 点击招募按钮时打开招募弹窗（任务 4 接入） */
  onRecruit(): void;
  /** 点击出征按钮时切换行军选择模式（任务 5 接入） */
  onMarch(): void;
  /** 点击打野按钮时切换打野选择模式（任务 6 接入） */
  onBandit(): void;
  /** 是否正处于行军选择模式（高亮出征按钮） */
  marchMode: boolean;
  /** 是否正处于打野选择模式（高亮打野按钮） */
  banditMode: boolean;
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
  { key: 'march', label: '出征', cost: ACTION_COSTS.march, kind: false, hint: '点击我方部队选择出发，再点目标格下达行军命令' },
  { key: 'recruit', label: '招募', cost: ACTION_COSTS.recruit, kind: true, hint: '消耗基础资源与行动点，为武将补充兵卒' },
  { key: 'bandit', label: '打野', cost: ACTION_COSTS.bandit, kind: true, hint: '攻打山贼营地，胜利掉落稀有材料' },
  { key: 'challenge', label: '挑战', cost: 0, kind: true, hint: '「挑战」对战将在后续迭代开放' },
  { key: 'siege', label: '攻城', cost: ACTION_COSTS.siege, kind: true, hint: '「攻城」军团战将在后续迭代开放' },
];

/** 底部行动点操作台：展示各操作消耗，行动点不足时置灰 */
export function ActionDeck({ ap, onRecruit, onMarch, onBandit, marchMode, banditMode }: ActionDeckProps) {
  const [hint, setHint] = useState<string | null>(null);
  return (
    <>
      {ACTIONS.map((action) => {
        const isOn = (action.key === 'march' && marchMode) || (action.key === 'bandit' && banditMode);
        return (
        <button
          key={action.key}
          type="button"
          className={`act${action.kind ? ' kind' : ''}${isOn ? ' act-on' : ''}`}
          disabled={action.cost > ap.current}
          onClick={() => {
            if (action.key === 'recruit') {
              onRecruit();
            } else if (action.key === 'march') {
              setHint(marchMode ? '行动点每 10 分钟恢复 1 点' : '点击我方部队选择出征，再点目标格下达命令');
              onMarch();
            } else if (action.key === 'bandit') {
              setHint('点击我方部队，再点野地目标发起攻打');
              onBandit();
            } else {
              setHint(action.hint);
            }
          }}
        >
          {action.label}
          {action.cost > 0 && <span className="cost">{action.cost} 行动点</span>}
        </button>
        );
      })}
      <span className="apnote">{hint ?? '行动点每 10 分钟恢复 1 点'}</span>
    </>
  );
}