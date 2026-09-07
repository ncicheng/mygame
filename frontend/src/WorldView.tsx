import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import type { ActionPoints, UserProfile, WorldArmy, WorldStateResponse } from '@mygame/shared';
import { apiCancelMarch, apiMarch, apiWorld } from './api';
import { ActionDeck } from './ActionDeck';
import { LeftColumn } from './LeftColumn';
import { MapBoard, describeCell, type MapCell } from './MapBoard';
import { RecruitModal } from './RecruitModal';
import { RightColumn } from './RightColumn';
import './world.css';

/** 服务器 WS 推送的行军位置增量 */
interface MarchUpdate {
  generalId: string;
  x: number;
  y: number;
}

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
  const [marchMode, setMarchMode] = useState(false);
  const [marchArmyId, setMarchArmyId] = useState<string | null>(null);
  const [marchMsg, setMarchMsg] = useState<string | null>(null);
  const [marchErr, setMarchErr] = useState<string | null>(null);
  const [marching, setMarching] = useState(false);

  // 首次加载世界
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

  // 实时渲染：订阅服务器世界时钟推送的行军位置，逐格移动。
  // 连接时携带 token，服务端据此把 socket 归入其所在世界的房间（只收本世界推送）。
  const socket = useMemo(() => io({ auth: { token } }), [token]);
  useEffect(() => {
    socket.on('march:update', (updates: MarchUpdate[]) => {
      setWorld((w) => {
        if (!w) {
          return w;
        }
        const byId = new Map(updates.map((u) => [u.generalId, u]));
        return {
          ...w,
          armies: w.armies.map((a) => {
            const u = byId.get(a.id);
            return u ? { ...a, x: u.x, y: u.y } : a;
          }),
        };
      });
    });
    return () => {
      socket.disconnect();
    };
  }, [socket]);

  // 同步结算：存在行军时周期性刷新，让到达（行军信息清除）与取消能落到界面
  useEffect(() => {
    const hasMarch = world?.armies.some((a) => a.march !== null) ?? false;
    if (!hasMarch) {
      return;
    }
    const id = setInterval(async () => {
      try {
        setWorld(await apiWorld(token));
      } catch {
        // 同步失败静默，下一轮再试
      }
    }, 2000);
    return () => clearInterval(id);
  }, [world, token]);

  const issueMarch = useCallback(
    async (target: MapCell) => {
      if (!marchArmyId || marching) {
        return;
      }
      const generalId = marchArmyId;
      setMarching(true);
      try {
        const res = await apiMarch(token, { generalId, targetX: target.x, targetY: target.y });
        setWorld((w) => {
          if (!w) {
            return w;
          }
          return {
            ...w,
            actionPoints: res.actionPoints,
            armies: w.armies.map((a) => (a.id === generalId ? { ...a, march: res.march } : a)),
          };
        });
        setMarchMode(false);
        setMarchArmyId(null);
        setMarchMsg(`「${target.x},${target.y}」行军已发布`);
        setMarchErr(null);
      } catch (err: unknown) {
        setMarchErr(err instanceof Error ? err.message : String(err));
      } finally {
        setMarching(false);
      }
    },
    [marchArmyId, token, marching],
  );

  const handleCellClick = useCallback(
    (cell: MapCell) => {
      if (marchMode && marchArmyId) {
        void issueMarch(cell);
        return;
      }
      setSelected(cell);
      setMarchErr(null);
    },
    [marchMode, marchArmyId, issueMarch],
  );

  const handleArmyClick = useCallback(
    (army: WorldArmy) => {
      setSelected(null);
      if (marchMode) {
        setMarchArmyId(army.id);
        setMarchMsg(`已选择「${army.generalName}」，点击地图目标格下达行军`);
        setMarchErr(null);
      } else {
        setMarchMsg(`已选中「${army.generalName}」，可查看行军或先出征`);
      }
    },
    [marchMode],
  );

  const handleCancelMarch = useCallback(
    async (marchId: string) => {
      if (!world) {
        return;
      }
      try {
        const res = await apiCancelMarch(token, marchId);
        setWorld((w) => {
          if (!w) {
            return w;
          }
          return {
            ...w,
            actionPoints: res.actionPoints,
            armies: w.armies.map((a) => (a.march?.id === marchId ? { ...a, march: null, x: res.march.originX, y: res.march.originY } : a)),
          };
        });
        setMarchMsg('行军已取消，部队返回起点');
        setMarchErr(null);
      } catch (err: unknown) {
        setMarchErr(err instanceof Error ? err.message : String(err));
      }
    },
    [token, world],
  );

  // 选中格上行军中的我方部队（用于展示到达时间与取消按钮）
  const selectedMarchArmy = selected?.markers.find((m) => m.army?.march)?.army ?? null;

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
          <MapBoard
            world={world}
            onCellClick={handleCellClick}
            onArmyClick={handleArmyClick}
            selectedArmyId={marchArmyId}
          />
          <div className="selbar">
            {selectedMarchArmy ? (
              <span className="marchbar">
                「{selectedMarchArmy.generalName}」行军至 ({selectedMarchArmy.march!.targetX},{selectedMarchArmy.march!.targetY}) ·{' '}
                {new Date(selectedMarchArmy.march!.arrivesAt).toLocaleTimeString()} 到达
                <button type="button" className="act kind" onClick={() => handleCancelMarch(selectedMarchArmy.march!.id)}>
                  取消行军
                </button>
              </span>
            ) : marchMsg ? (
              marchMsg
            ) : selected ? (
              describeCell(selected)
            ) : marchMode ? (
              '行军模式：点击我方部队选择出发，再点目标格'
            ) : (
              '点击格子查看详情'
            )}
          </div>
          {marchErr && <div className="march-err">{marchErr}</div>}
        </section>
        <aside className="col">
          <RightColumn user={user} world={world} />
        </aside>
      </div>
      <footer className="vc-bottom">
        <ActionDeck
          ap={world.actionPoints}
          onRecruit={() => setRecruiting(true)}
          onMarch={() => {
            setMarchMode((m) => !m);
            setMarchArmyId(null);
            setMarchErr(null);
          }}
          marchMode={marchMode}
        />
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
