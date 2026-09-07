import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionPoints, BattleReport, UserProfile, WorldArmy, WorldStateResponse } from '@mygame/shared';
import { apiBattleReports, apiCancelMarch, apiMarch, apiWorld } from './api';
import { createRealtimeSocket } from './realtime';
import { ActionDeck } from './ActionDeck';
import { BattleOverlay } from './BattleOverlay';
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
  const [banditMode, setBanditMode] = useState(false);
  const [marchArmyId, setMarchArmyId] = useState<string | null>(null);
  const [marchMsg, setMarchMsg] = useState<string | null>(null);
  const [marchErr, setMarchErr] = useState<string | null>(null);
  const [marching, setMarching] = useState(false);
  const [reports, setReports] = useState<BattleReport[]>([]);
  const [activeReport, setActiveReport] = useState<BattleReport | null>(null);
  const pendingBattleRef = useRef(false);
  const lastAutoReportRef = useRef<string | null>(null);

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
  // 连接地址与 fetch 同用 API_BASE；每次渲染/重挂载创建全新 socket 实例，
  // 避免 StrictMode 下复用已被 disconnect 且无法重连的缓存实例。
  useEffect(() => {
    const socket = createRealtimeSocket(token);
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
  }, [token]);

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

  // 战报轮询：刷新战报卡；刚发起打野后，若出现新战报则自动打开战斗回放
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiBattleReports(token);
        if (cancelled) {
          return;
        }
        setReports(res.reports);
        const newest = res.reports[0];
        if (newest && newest.id !== lastAutoReportRef.current && pendingBattleRef.current) {
          lastAutoReportRef.current = newest.id;
          pendingBattleRef.current = false;
          setActiveReport(newest);
        }
      } catch {
        // 拉取失败静默，下一轮再试
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token]);

  const issueMarch = useCallback(
    async (target: MapCell, attack: boolean) => {
      if (!marchArmyId || marching) {
        return;
      }
      const generalId = marchArmyId;
      setMarching(true);
      try {
        const res = await apiMarch(token, { generalId, targetX: target.x, targetY: target.y });
        if (attack) {
          // 打野行军：到达后触发战斗，预期会产生新战报 → 标记以便自动打开回放
          pendingBattleRef.current = true;
        }
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
        setBanditMode(false);
        setMarchArmyId(null);
        setMarchMsg(`「${target.x},${target.y}」${attack ? '打野出征' : '行军'}已发布`);
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
      if ((marchMode || banditMode) && marchArmyId) {
        if (banditMode && !cell.markers.some((m) => m.kind === 'bandit')) {
          setMarchErr('请选择野地（山贼营地）目标格发起攻打');
          return;
        }
        void issueMarch(cell, banditMode);
        return;
      }
      setSelected(cell);
      setMarchErr(null);
    },
    [marchMode, banditMode, marchArmyId, issueMarch],
  );

  const handleArmyClick = useCallback(
    (army: WorldArmy) => {
      setSelected(null);
      if (marchMode || banditMode) {
        setMarchArmyId(army.id);
        setMarchMsg(banditMode ? `已选择「${army.generalName}」，点击野地目标攻打` : `已选择「${army.generalName}」，点击地图目标格下达行军`);
        setMarchErr(null);
      } else {
        setMarchMsg(`已选中「${army.generalName}」，可查看行军或先出征`);
      }
    },
    [marchMode, banditMode],
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
          <LeftColumn user={user} token={token} onUserUpdate={onUserUpdate} />
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
          <RightColumn user={user} world={world} reports={reports} onOpenReport={setActiveReport} />
        </aside>
      </div>
      <footer className="vc-bottom">
        <ActionDeck
          ap={world.actionPoints}
          onRecruit={() => setRecruiting(true)}
          onMarch={() => {
            setMarchMode((m) => !m);
            setBanditMode(false);
            setMarchArmyId(null);
            setMarchErr(null);
          }}
          onBandit={() => {
            setBanditMode((m) => !m);
            setMarchMode(false);
            setMarchArmyId(null);
            setMarchErr(null);
          }}
          marchMode={marchMode}
          banditMode={banditMode}
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
      {activeReport && <BattleOverlay report={activeReport} onClose={() => setActiveReport(null)} />}
    </div>
  );
}
