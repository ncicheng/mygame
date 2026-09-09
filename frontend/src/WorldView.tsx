import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BattleReport,
  CombatSideInput,
  General,
  Resources,
  WorldArmy,
  WorldMarch,
  WorldStateResponse,
} from '@mygame/shared';
import { INITIAL_TROOP_UNLOCK, MARCH_TILE_MS } from '@mygame/shared';
import type { AuthUser } from './auth';
import {
  cancelMarch,
  fetchGeneral,
  fetchReports,
  fetchResources,
  fetchTroopMaxUnlocked,
  fetchWorld,
  finalizeMarch,
} from './data';
import { computeMarchPosition, issueMarch, settleBattle } from './game';
import { ActionDeck } from './ActionDeck';
import { BattleOverlay } from './BattleOverlay';
import { CopyrightFooter } from './CopyrightFooter';
import { LeftColumn } from './LeftColumn';
import { MapBoard, describeCell, type MapCell } from './MapBoard';
import { RecruitModal } from './RecruitModal';
import { RightColumn } from './RightColumn';
import './world.css';

interface WorldViewProps {
  user: AuthUser;
  onLogout(): void;
}

/**
 * 轮询刷新时保留我方进行中行军的本地插值位置，避免用落库坐标（仍为起点）
 * 整包覆盖导致部队回弹。仅当新状态里该部队仍为 active 行军时才沿用旧插值，
 * 否则（行军已到达/取消）交由数据库坐标纠正。
 */
function mergeActiveMarchPositions(
  next: WorldStateResponse,
  prev: WorldStateResponse | null,
): WorldStateResponse {
  if (!prev) {
    return next;
  }
  const marching = new Map<string, { x: number; y: number }>();
  for (const a of prev.armies) {
    if (a.side === 'me' && a.march?.status === 'active') {
      marching.set(a.id, { x: a.x, y: a.y });
    }
  }
  if (marching.size === 0) {
    return next;
  }
  return {
    ...next,
    armies: next.armies.map((a) =>
      a.march?.status === 'active' && marching.has(a.id)
        ? { ...a, x: marching.get(a.id)!.x, y: marching.get(a.id)!.y }
        : a,
    ),
  };
}

/** 登录后主界面：变体 C「运筹帷幄」桌游指挥台布局。
 * 全部数据来自 data.ts（Supabase），行军位置本地 computeMarchPosition 插值渲染，
 * 以 setInterval 轮询 fetchWorld 刷新到达/资源/战报。 */
export function WorldView({ user, onLogout }: WorldViewProps) {
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
  // 玩家自身数据（武将/资源/兵种解锁/战报）
  const [general, setGeneral] = useState<General | null>(null);
  const [resources, setResources] = useState<Resources | null>(null);
  const [troopMax, setTroopMax] = useState<number>(INITIAL_TROOP_UNLOCK);
  const worldRef = useRef<WorldStateResponse | null>(null);
  const pendingBattleRef = useRef(false);
  const lastAutoReportRef = useRef<string | null>(null);
  // 已处理（结算/刷新）的行军 id，避免到达后重复触发
  const processedMarchRef = useRef<Set<string>>(new Set());

  // 世界状态与玩家数据（各取所需，任一失败不拖累整体）
  const refreshAll = useCallback(
    async (showError: boolean) => {
      const [w, gen, res, max, rep] = await Promise.allSettled([
        fetchWorld(user.id),
        fetchGeneral(user.id),
        fetchResources(user.id),
        fetchTroopMaxUnlocked(user.id),
        fetchReports(user.id),
      ]);
      if (w.status === 'fulfilled') {
        setWorld((prev) => mergeActiveMarchPositions(w.value, prev));
      } else if (showError) {
        setError(w.reason instanceof Error ? w.reason.message : String(w.reason));
      }
      if (gen.status === 'fulfilled') setGeneral(gen.value);
      if (res.status === 'fulfilled') setResources(res.value);
      if (max.status === 'fulfilled') setTroopMax(max.value);
      if (rep.status === 'fulfilled') setReports(rep.value);
    },
    [user.id],
  );

  // 首次加载 + 周期轮询：到达/资源/战报落到界面
  useEffect(() => {
    void refreshAll(true);
    const poll = setInterval(() => void refreshAll(false), 2000);
    return () => clearInterval(poll);
  }, [refreshAll]);

  // 行军到达的本地结算：打野行军到达 → settleBattle，普通行军 → 刷新落库位置
  const settleArrivedBattle = useCallback(
    async (generalId: string, march: WorldMarch) => {
      const cur = worldRef.current;
      if (!cur) {
        return;
      }
      const wildland = cur.wildlands.find((wl) => wl.x === march.targetX && wl.y === march.targetY);
      if (!wildland) {
        // 纯移动行军到达：把武将落位到目标格并把行军置为 arrived，否则行军卡在
        // active，唯一索引会挡住后续新行军（duplicate key）。
        try {
          await finalizeMarch(user.id, generalId, march.id, march.targetX, march.targetY);
          await refreshAll(false);
        } catch (err) {
          setMarchErr(err instanceof Error ? err.message : String(err));
          await refreshAll(false);
        }
        return;
      }
      try {
        // 野地守军：power/count 均取 strength（复刻旧后端 battle.ts 语义）
        const defender: CombatSideInput = {
          generalLevel: 1,
          generalStars: 1,
          weaponTier: null,
          army: [{ soldierLevel: 1, count: wildland.strength }],
        };
        await settleBattle(user.id, generalId, defender, {
          worldId: cur.world.id,
          wildlandId: wildland.id,
          wildlandName: wildland.name,
          marchId: march.id,
          targetX: march.targetX,
          targetY: march.targetY,
        });
        await refreshAll(false);
        // 结算后自动打开最新战报（回放）
        const rep = await fetchReports(user.id);
        setReports(rep);
        const newest = rep[0];
        if (newest && newest.id !== lastAutoReportRef.current) {
          lastAutoReportRef.current = newest.id;
          setActiveReport(newest);
        }
      } catch (err) {
        setMarchErr(err instanceof Error ? err.message : String(err));
        await refreshAll(false);
      }
    },
    [user.id, refreshAll],
  );

  // 行军本地插值渲染 + 到达检测
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      // 我方行军按出发时刻逐格推进
      setWorld((w) => {
        if (!w) {
          return w;
        }
        return {
          ...w,
          armies: w.armies.map((a) =>
            a.side === 'me' && a.march?.status === 'active'
              ? { ...a, x: computeMarchPosition(a.march, now).x, y: computeMarchPosition(a.march, now).y }
              : a,
          ),
        };
      });
      // 到达处理（用 worldRef 当前已提交值）
      const cur = worldRef.current;
      for (const army of cur?.armies ?? []) {
        const m = army.march;
        if (!m || m.status !== 'active') {
          continue;
        }
        if (now < new Date(m.arrivesAt).getTime()) {
          continue;
        }
        if (processedMarchRef.current.has(m.id)) {
          continue;
        }
        processedMarchRef.current.add(m.id);
        if (pendingBattleRef.current) {
          pendingBattleRef.current = false;
          void settleArrivedBattle(army.id, m);
        } else {
          void refreshAll(false);
        }
      }
    }, 500);
    return () => clearInterval(id);
  }, [settleArrivedBattle, refreshAll]);

  // 世界状态同步到 ref（间隔内读取当前值）
  useEffect(() => {
    worldRef.current = world;
  }, [world]);

  const handleIssueMarch = useCallback(
    async (target: MapCell, attack: boolean) => {
      if (!marchArmyId || marching) {
        return;
      }
      const army = worldRef.current?.armies.find((a) => a.id === marchArmyId);
      const worldNow = worldRef.current;
      if (!army || !worldNow) {
        setMarchErr('未找到所选部队');
        return;
      }
      const generalId = army.id;
      setMarching(true);
      try {
        const distance = Math.abs(target.x - army.x) + Math.abs(target.y - army.y);
        const departedAt = new Date().toISOString();
        const arrivesAt = new Date(Date.now() + distance * MARCH_TILE_MS).toISOString();
        const march = await issueMarch(user.id, generalId, target.x, target.y, {
          worldId: worldNow.world.id,
          originX: army.x,
          originY: army.y,
          departedAt,
          arrivesAt,
        });
        if (attack) {
          // 打野行军：到达后本地结算战斗，预期产生新战报 → 标记以便自动打开回放
          pendingBattleRef.current = true;
        }
        // 落位行军，交由插值渲染
        setWorld((w) =>
          w ? { ...w, armies: w.armies.map((a) => (a.id === generalId ? { ...a, march } : a)) } : w,
        );
        setMarchMode(false);
        setBanditMode(false);
        setMarchArmyId(null);
        setMarchMsg(`「${target.x},${target.y}」${attack ? '打野出征' : '行军'}已发布`);
        setMarchErr(null);
      } catch (err) {
        setMarchErr(err instanceof Error ? err.message : String(err));
      } finally {
        setMarching(false);
      }
    },
    [marchArmyId, user.id, marching],
  );

  const handleCellClick = useCallback(
    (cell: MapCell) => {
      if ((marchMode || banditMode) && marchArmyId) {
        if (banditMode && !cell.markers.some((m) => m.kind === 'bandit')) {
          setMarchErr('请选择野地（山贼营地）目标格发起攻打');
          return;
        }
        void handleIssueMarch(cell, banditMode);
        return;
      }
      setSelected(cell);
      setMarchErr(null);
    },
    [marchMode, banditMode, marchArmyId, handleIssueMarch],
  );

  const handleArmyClick = useCallback(
    (army: WorldArmy) => {
      setSelected(null);
      if (marchMode || banditMode) {
        setMarchArmyId(army.id);
        setMarchMsg(
          banditMode
            ? `已选择「${army.generalName}」，点击野地目标攻打`
            : `已选择「${army.generalName}」，点击地图目标格下达行军`,
        );
        setMarchErr(null);
      } else {
        setMarchMsg(`已选中「${army.generalName}」，可查看行军或先出征`);
      }
    },
    [marchMode, banditMode],
  );

  const handleCancelMarch = useCallback(
    async (marchId: string) => {
      try {
        await cancelMarch(user.id, marchId);
        await refreshAll(false);
        setMarchMsg('行军已取消，部队返回起点');
        setMarchErr(null);
      } catch (err) {
        setMarchErr(err instanceof Error ? err.message : String(err));
      }
    },
    [user.id, refreshAll],
  );

  // 选中格上行军中的我方部队（用于展示到达时间与取消按钮）
  const selectedMarchArmy = selected?.markers.find((m) => m.army?.march)?.army ?? null;

  // 招募/养成成功：刷新世界与玩家数据
  const handleChanged = useCallback(() => {
    void refreshAll(false);
  }, [refreshAll]);

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
        <h1 className="mg-title">⚔ MyGame 指挥台</h1>
        <span className="pl">
          {user.email ?? user.id} · Lv.{general?.level ?? 1}
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
          <LeftColumn
            userId={user.id}
            general={general}
            rare={resources?.rare ?? 0}
            troopMaxUnlocked={troopMax}
            onChanged={handleChanged}
          />
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
                「{selectedMarchArmy.generalName}」行军至 ({selectedMarchArmy.march!.targetX},
                {selectedMarchArmy.march!.targetY}) ·{' '}
                {new Date(selectedMarchArmy.march!.arrivesAt).toLocaleTimeString()} 到达
                <button
                  type="button"
                  className="act kind"
                  onClick={() => handleCancelMarch(selectedMarchArmy.march!.id)}
                >
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
          <RightColumn resources={resources} world={world} reports={reports} onOpenReport={setActiveReport} />
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
      <CopyrightFooter />
      {recruiting && (
        <RecruitModal
          userId={user.id}
          general={general}
          resources={resources}
          troopMaxUnlocked={troopMax}
          ap={world.actionPoints.current}
          onClose={() => setRecruiting(false)}
          onRecruited={handleChanged}
        />
      )}
      {activeReport && <BattleOverlay report={activeReport} onClose={() => setActiveReport(null)} />}
    </div>
  );
}
