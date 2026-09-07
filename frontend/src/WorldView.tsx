import { useCallback, useEffect, useState } from 'react';
import type { ActionPoints, UserProfile, WorldStateResponse } from '@mygame/shared';
import { apiWorld } from './api';
import { ActionDeck } from './ActionDeck';
import { LeftColumn } from './LeftColumn';
import { MapBoard, describeCell, type MapCell } from './MapBoard';
import { RecruitModal } from './RecruitModal';
import { RightColumn } from './RightColumn';
import './world.css';

interface WorldViewProps {
  user: UserProfile;
  token: string;
  onLogout(): void;
  /** 招募等业务更新档案后提升到 App 状态（资源卡/部队编成卡实时刷新） */
  onUserUpdate(user: UserProfile): void;
}

/** 登录后主界面：变体 C「运筹帷幄」桌游指挥台布局 */
export function WorldView({ user, token, onLogout, onUserUpdate }: WorldViewProps) {
  const [world, setWorld] = useState<WorldStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MapCell | null>(null);
  const [recruiting, setRecruiting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setWorld(null);
    apiWorld(token)
      .then((w) => {
        if (cancelled) {
          return;
        }
        setWorld(w);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleCellClick = useCallback((cell: MapCell) => {
    setSelected(cell);
  }, []);

  // 招募成功：档案提升到 App，行动点就地刷新（不重新拉取世界）
  const handleRecruited = useCallback(
    (updatedUser: UserProfile, actionPoints: ActionPoints) => {
      onUserUpdate(updatedUser);
      setWorld((w) => (w ? { ...w, actionPoints } : w));
    },
    [onUserUpdate],
  );

  if (error || !world) {
    return (
      <div className="vc">
        <div className="vc-status vc-status-error">
          {error ?? '世界加载失败'}{' '}
          <button type="button" className="act kind" onClick={() => window.location.reload()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="vc">
      <header className="vc-top">
        <h1>⚔ MyGame 指挥台</h1>
        <span className="pl">
          {user.username} · Lv.{user.generals[0]?.level ?? 1}
        </span>
        <span className="ap">
          行动点 {world.actionPoints.current}/{world.actionPoints.max}
        </span>
        <button type="button" className="logout" onClick={onLogout}>
          登出
        </button>
      </header>
      <div className="vc-main">
        <aside className="col">
          <LeftColumn user={user} />
        </aside>
        <section className="boardwrap">
          <MapBoard world={world} onCellClick={handleCellClick} />
          <div className="selbar">{selected ? describeCell(selected) : '点击格子查看详情'}</div>
        </section>
        <aside className="col">
          <RightColumn user={user} world={world} />
        </aside>
      </div>
      <footer className="vc-bottom">
        <ActionDeck ap={world.actionPoints} onRecruit={() => setRecruiting(true)} />
      </footer>
      {recruiting && (
        <RecruitModal
          user={user}
          token={token}
          ap={world.actionPoints.current}
          onClose={() => setRecruiting(false)}
          onRecruited={handleRecruited}
        />
      )}
    </div>
  );
}