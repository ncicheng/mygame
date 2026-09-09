import { useState } from 'react';
import { CopyrightFooter } from './CopyrightFooter';

// 新手引导步骤数据：编号 / 标题 / 说明
const STEPS = [
  {
    title: '认识底部操作台',
    body:
      '底部操作台是你指挥全军的中枢，包含「出征」「招募」「打野」「攻城」四大按钮。' +
      '每一次行动都会消耗「行动点」，行动点会随时间恢复，合理安排有限的行动点是制胜关键。',
  },
  {
    title: '下达行军命令',
    body:
      '先选中我方武将，再点选地图上的目标格子下达行军命令。' +
      '武将便会沿最短路径向目标前进，行军途中请留意粮草与体力消耗。',
  },
  {
    title: '行军打野与战报',
    body:
      '让武将行军到野地即可自动发起打野战斗。' +
      '战斗结果会实时呈现在右侧的「战报卡」中，可查看胜负、战损与掉落。',
  },
  {
    title: '养成强化武器',
    body:
      '用打野掉落的稀有材料，可在左侧「养成卡」中强化武器、解锁更强兵种。' +
      '养成越强，出征攻城便越有胜算。',
  },
];

/** 全屏新手引导覆盖层：分步讲解 + 跳过引导 */
export function Tutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      onClose();
    } else {
      setStep(step + 1);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="新手引导"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(6, 8, 12, 0.72)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div className="mg-card mg-slide-up" style={{ maxWidth: 440, width: 'calc(100% - 48px)', padding: '28px 26px' }}>
        <div className="mg-accent" style={{ fontSize: 13, letterSpacing: 1, marginBottom: 10 }}>
          新手引导 · {step + 1}/{STEPS.length}
        </div>
        <h2 className="mg-title" style={{ fontSize: 20, margin: 0, marginBottom: 12 }}>
          {current.title}
        </h2>
        <p style={{ fontSize: 14, lineHeight: 1.8, color: 'var(--mg-text-dim)', margin: 0, marginBottom: 22 }}>
          {current.body}
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <button type="button" className="mg-btn ghost" onClick={onClose}>
            跳过引导
          </button>
          <button type="button" className="mg-btn" onClick={handleNext}>
            {isLast ? '开始游戏' : '下一步'}
          </button>
        </div>
      </div>
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
        <CopyrightFooter />
      </div>
    </div>
  );
}
