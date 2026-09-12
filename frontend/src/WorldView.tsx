import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  createGuild,
  fetchChallenges,
  fetchGeneral,
  fetchGuildMembers,
  fetchGuilds,
  fetchMyGuild,
  fetchNickname,
  fetchProtection,
  fetchReports,
  fetchResources,
  fetchSieges,
  fetchTerritory,
  fetchTroopMaxUnlocked,
  fetchWorld,
  setNickname,
  finalizeMarch,
  initiateChallenge,
  initiateSiege,
  joinGuild,
  leaveGuild,
  type Challenge,
  type Guild,
  type GuildMember,
  type Siege,
} from './data';
import { computeMarchPosition, issueMarch, settleBattle } from './game';
import { computeQuests } from './quests';
import { computeStats } from './stats';
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
  isAdmin: boolean;
  onLogout(): void;
  onOpenAdmin(): void;
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
export function WorldView({ user, isAdmin, onLogout, onOpenAdmin }: WorldViewProps) {
  const [world, setWorld] = useState<WorldStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MapCell | null>(null);
  const [recruiting, setRecruiting] = useState(false);
  const [marchMode, setMarchMode] = useState(false);
  const [banditMode, setBanditMode] = useState(false);
  const [challengeMode, setChallengeMode] = useState(false);
  const [siegeMode, setSiegeMode] = useState(false);
  const [marchArmyId, setMarchArmyId] = useState<string | null>(null);
  const [marchMsg, setMarchMsg] = useState<string | null>(null);
  const [marchErr, setMarchErr] = useState<string | null>(null);
  const [marching, setMarching] = useState(false);
  const [reports, setReports] = useState<BattleReport[]>([]);
  const [activeReport, setActiveReport] = useState<BattleReport | null>(null);
  // PvP 挑战：最近挑战列表 + 发起中的加载态 + 提示
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [challenging, setChallenging] = useState(false);
  const [challengeMsg, setChallengeMsg] = useState<string | null>(null);
  // 攻城：最近攻城记录 + 发起中的加载态 + 提示
  const [sieges, setSieges] = useState<Siege[]>([]);
  const [sieging, setSieging] = useState(false);
  const [siegeMsg, setSiegeMsg] = useState<string | null>(null);
  // 玩家自身数据（武将/资源/兵种解锁/战报）
  const [general, setGeneral] = useState<General | null>(null);
  const [resources, setResources] = useState<Resources | null>(null);
  const [troopMax, setTroopMax] = useState<number>(INITIAL_TROOP_UNLOCK);
  // 免战期截止时间（ISO 字符串）；null 表示无免战期
  const [protectionUntil, setProtectionUntil] = useState<string | null>(null);
  // 军团数据：所属军团、可加入列表、成员
  const [myGuild, setMyGuild] = useState<Guild | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [guildMembers, setGuildMembers] = useState<GuildMember[]>([]);
  // 玩家昵称与领地（城池数）
  const [nickname, setNicknameState] = useState<string | null>(null);
  const [territory, setTerritory] = useState(0);
  // 军团成员 user_id → 昵称
  const [memberNicknames, setMemberNicknames] = useState<Record<string, string | null>>({});
  const worldRef = useRef<WorldStateResponse | null>(null);
  const pendingBattleRef = useRef(false);
  const lastAutoReportRef = useRef<string | null>(null);
  // 已处理（结算/刷新）的行军 id，避免到达后重复触发
  const processedMarchRef = useRef<Set<string>>(new Set());

  // 世界状态与玩家数据（各取所需，任一失败不拖累整体）
  const refreshAll = useCallback(
    async (showError: boolean) => {
      const [w, gen, res, max, rep, myG, gs, ch, prot, nick, sg] = await Promise.allSettled([
        fetchWorld(user.id),
        fetchGeneral(user.id),
        fetchResources(user.id),
        fetchTroopMaxUnlocked(user.id),
        fetchReports(user.id),
        fetchMyGuild(user.id),
        fetchGuilds(),
        fetchChallenges(user.id),
        fetchProtection(user.id),
        fetchNickname(user.id),
        fetchSieges(user.id),
      ]);
      if (w.status === 'fulfilled') {
        setWorld((prev) => mergeActiveMarchPositions(w.value, prev));
        // 领地数依赖世界 id，须待 fetchWorld 返回后再查；失败静默（非关键）
        try {
          setTerritory(await fetchTerritory(user.id, w.value.world.id));
        } catch {
          setTerritory(0);
        }
      } else if (showError) {
        setError(w.reason instanceof Error ? w.reason.message : String(w.reason));
      }
      if (gen.status === 'fulfilled') setGeneral(gen.value);
      if (res.status === 'fulfilled') setResources(res.value);
      if (max.status === 'fulfilled') setTroopMax(max.value);
      if (rep.status === 'fulfilled') setReports(rep.value);
      if (myG.status === 'fulfilled') {
        setMyGuild(myG.value);
        // 已加入军团时加载其成员列表；失败静默（成员列表非关键，避免每 2s
        // 轮询因 fetchGuildMembers 抛错产生未处理的 Promise rejection）
        if (myG.value) {
          try {
            const mem = await fetchGuildMembers(myG.value.id);
            setGuildMembers(mem);
            // 批量拉取各成员昵称（Promise.all），任一失败静默降级为原始 id
            const entries = await Promise.all(
              mem.map((m) => fetchNickname(m.userId).catch(() => null)),
            );
            const map: Record<string, string | null> = {};
            mem.forEach((m, i) => {
              map[m.userId] = entries[i];
            });
            setMemberNicknames(map);
          } catch {
            setGuildMembers([]);
            setMemberNicknames({});
          }
        } else {
          setGuildMembers([]);
          setMemberNicknames({});
        }
      }
      if (gs.status === 'fulfilled') setGuilds(gs.value);
      if (ch.status === 'fulfilled') setChallenges(ch.value);
      if (prot.status === 'fulfilled') setProtectionUntil(prot.value.peaceProtectionUntil);
      if (nick.status === 'fulfilled') setNicknameState(nick.value);
      if (sg.status === 'fulfilled') setSieges(sg.value);
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
          // 纯移动行军到达也走 settleArrivedBattle：内部无野地时 finalizeMarch 落位并置 arrived，
          // 否则行军卡在 active，唯一索引会挡住后续新行军。
          void settleArrivedBattle(army.id, m);
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

  // 攻城入口：以本人主武将发起对选中敌方城池的攻城，结算后刷新攻城列表
  const handleSiege = useCallback(
    async (targetCityId: string) => {
      if (sieging || !general) {
        setSiegeMsg(!general ? '尚未拥有武将，无法发起攻城' : null);
        return;
      }
      setSieging(true);
      setSiegeMsg(null);
      try {
        await initiateSiege(user.id, general.id, targetCityId);
        await refreshAll(false);
        setSiegeMsg('攻城已结算，结果见右侧攻城卡');
        setSelected(null);
        setSiegeMode(false);
      } catch (err) {
        setSiegeMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setSieging(false);
      }
    },
    [user.id, general, sieging, refreshAll],
  );

  // 挑战入口：以本人主武将发起对选中敌方部队的 1v1 PvP 挑战，结算后刷新挑战列表
  const handleChallenge = useCallback(
    async (targetGeneralId: string) => {
      if (challenging || !general) {
        setChallengeMsg(!general ? '尚未拥有武将，无法发起挑战' : null);
        return;
      }
      setChallenging(true);
      setChallengeMsg(null);
      try {
        await initiateChallenge(user.id, general.id, targetGeneralId);
        await refreshAll(false);
        setChallengeMsg('挑战已结算，结果见右侧挑战列表');
        setSelected(null);
        setChallengeMode(false);
      } catch (err) {
        setChallengeMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setChallenging(false);
      }
    },
    [user.id, general, challenging, refreshAll],
  );

  // 出征/打野模式互斥切换：开启所选模式并关闭其他，避免多模式叠加
  const handleMarchToggle = useCallback(() => {
    const next = !marchMode;
    setMarchMode(next);
    if (next) {
      setBanditMode(false);
      setChallengeMode(false);
      setSiegeMode(false);
    }
    setMarchArmyId(null);
    setMarchErr(null);
    setChallengeMsg(null);
    setSiegeMsg(null);
  }, [marchMode]);

  const handleBanditToggle = useCallback(() => {
    const next = !banditMode;
    setBanditMode(next);
    if (next) {
      setMarchMode(false);
      setChallengeMode(false);
      setSiegeMode(false);
    }
    setMarchArmyId(null);
    setMarchErr(null);
    setChallengeMsg(null);
    setSiegeMsg(null);
  }, [banditMode]);

  const handleChallengeToggle = useCallback(() => {
    const next = !challengeMode;
    setChallengeMode(next);
    if (next) {
      setMarchMode(false);
      setBanditMode(false);
      setSiegeMode(false);
      setMarchArmyId(null);
    }
    setMarchErr(null);
    setChallengeMsg(null);
    setSiegeMsg(null);
  }, [challengeMode]);

  const handleSiegeToggle = useCallback(() => {
    const next = !siegeMode;
    setSiegeMode(next);
    if (next) {
      setMarchMode(false);
      setBanditMode(false);
      setChallengeMode(false);
      setMarchArmyId(null);
    }
    setMarchErr(null);
    setChallengeMsg(null);
    setSiegeMsg(null);
  }, [siegeMode]);

  const handleCellClick = useCallback(
    (cell: MapCell) => {
      if (challengeMode) {
        const enemy = cell.markers.find((m) => m.army?.side === 'enemy')?.army ?? null;
        if (enemy) {
          void handleChallenge(enemy.id);
          return;
        }
        setChallengeMsg('请点击敌方部队发起挑战');
        return;
      }
      if (siegeMode) {
        const enemyCity = cell.markers.find((m) => m.kind === 'city' && m.side === 'enemy');
        if (enemyCity?.cityId) {
          void handleSiege(enemyCity.cityId);
          return;
        }
        setSiegeMsg('请点击敌方城池发起攻城');
        return;
      }
      if (marchMode || banditMode) {
        // 未选部队：若格子上有我军则自动选中，否则给出清晰引导（修复「点了没反应」）
        if (!marchArmyId) {
          const myArmy = cell.markers.find((m) => m.army?.side === 'me')?.army ?? null;
          if (myArmy) {
            setMarchArmyId(myArmy.id);
            setMarchMsg(
              banditMode
                ? `已选择「${myArmy.generalName}」，点击野地目标攻打`
                : `已选择「${myArmy.generalName}」，点击地图目标格下达行军`,
            );
            setMarchErr(null);
            return;
          }
          setMarchErr(banditMode ? '请先点击我方部队（军）选择出征，再点野地攻打' : '请先点击我方部队（军）选择出征，再点目标格');
          return;
        }
        if (banditMode && !cell.markers.some((m) => m.kind === 'bandit')) {
          setMarchErr('请选择野地（山贼营地）目标格发起攻打');
          return;
        }
        void handleIssueMarch(cell, banditMode);
        return;
      }
      setSelected(cell);
      setMarchErr(null);
      setChallengeMsg(null);
      setSiegeMsg(null);
    },
    [marchMode, banditMode, challengeMode, siegeMode, marchArmyId, handleIssueMarch, handleChallenge, handleSiege],
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

  // 设置昵称：调用 data.ts 后刷新玩家数据
  const handleSetNickname = useCallback(
    async (name: string) => {
      try {
        await setNickname(user.id, name);
        await refreshAll(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [user.id, refreshAll],
  );

  // 军团操作：调用 data.ts 后刷新军团数据
  const handleCreateGuild = useCallback(    async (name: string) => {
      try {
        await createGuild(user.id, name);
        await refreshAll(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [user.id, refreshAll],
  );

  const handleJoinGuild = useCallback(
    async (guildId: string) => {
      try {
        await joinGuild(user.id, guildId);
        await refreshAll(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [user.id, refreshAll],
  );

  const handleLeaveGuild = useCallback(
    async (guildId: string) => {
      try {
        await leaveGuild(user.id, guildId);
        await refreshAll(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [user.id, refreshAll],
  );

  // 选中格上的敌方部队（side='enemy'）；选中敌方时显示"挑战"入口
  const selectedEnemyArmy = selected?.markers.find((m) => m.army?.side === 'enemy')?.army ?? null;

  // 选中格上的敌方城池（side='enemy'）；选中敌方城池时显示"攻城"入口
  const selectedEnemyCity = selected?.markers.find((m) => m.kind === 'city' && m.side === 'enemy') ?? null;

  // 城池 id → 名称：攻城卡展示目标城名用（hooks 须无条件调用，world 可为空）
  const cityNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of world?.cities ?? []) {
      map[c.id] = c.name;
    }
    return map;
  }, [world]);

  // 全局统计：由战报/攻城/挑战/资源/养成聚合派生，供右栏「统计」卡展示
  const stats = useMemo(
    () =>
      computeStats({
        userId: user.id,
        reports,
        sieges,
        challenges,
        resources,
        general,
        troops: general?.army ?? [],
      }),
    [user.id, reports, sieges, challenges, resources, general],
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
        <h1 className="mg-title">🏯 运筹帷幄</h1>
        <span className="pl">
          {nickname ?? user.email ?? user.id} · Lv.{general?.level ?? 1} · 领地 {territory} 城
        </span>
        <span className="ap">
          行动点 {world.actionPoints.current}/{world.actionPoints.max}
        </span>
        {isAdmin && (
          <button type="button" className="logout" onClick={onOpenAdmin}>
            后台
          </button>
        )}
        <button type="button" className="logout" onClick={onLogout}>
          登出
        </button>
      </header>
      <div className="vc-main">
        <aside className="col">
          <LeftColumn
            userId={user.id}
            nickname={nickname}
            onSetNickname={(name) => void handleSetNickname(name)}
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
            {selectedEnemyCity ? (
              <span className="marchbar">
                敌方城池「{selectedEnemyCity.cityName ?? selectedEnemyCity.label}」· ({selected!.x},
                {selected!.y})
                <button
                  type="button"
                  className="act kind"
                  disabled={sieging}
                  onClick={() => selectedEnemyCity.cityId && void handleSiege(selectedEnemyCity.cityId)}
                >
                  {sieging ? '攻城中…' : '攻城'}
                </button>
              </span>
            ) : selectedEnemyArmy ? (
              <span className="marchbar">
                敌方「{selectedEnemyArmy.generalName}」· 兵力 {selectedEnemyArmy.troopCount.toLocaleString()}
                <button
                  type="button"
                  className="act kind"
                  disabled={challenging}
                  onClick={() => void handleChallenge(selectedEnemyArmy.id)}
                >
                  {challenging ? '挑战中…' : '挑战'}
                </button>
              </span>
            ) : selectedMarchArmy ? (
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
          {challengeMsg && <div className="march-err">{challengeMsg}</div>}
          {siegeMsg && <div className="march-err">{siegeMsg}</div>}
        </section>
        <aside className="col">
          <RightColumn
            userId={user.id}
            resources={resources}
            territory={territory}
            memberNicknames={memberNicknames}
            stats={stats}
            reports={reports}
            challenges={challenges}
            sieges={sieges}
            cityNameById={cityNameById}
            quests={computeQuests({
              reports,
              troops: general?.army ?? [],
              armies: world.armies,
              weaponTier: general?.weapon?.tier ?? 1,
              troopMaxUnlocked: troopMax,
              generalLevel: general?.level ?? 1,
            })}
            onOpenReport={setActiveReport}
            peaceProtectionUntil={protectionUntil}
            myGuild={myGuild}
            guilds={guilds}
            members={guildMembers}
            onCreateGuild={(name) => void handleCreateGuild(name)}
            onJoinGuild={(guildId) => void handleJoinGuild(guildId)}
            onLeaveGuild={(guildId) => void handleLeaveGuild(guildId)}
          />
        </aside>
      </div>
      <footer className="vc-bottom">
        <ActionDeck
          ap={world.actionPoints}
          onRecruit={() => setRecruiting(true)}
          onMarch={handleMarchToggle}
          onBandit={handleBanditToggle}
          onChallenge={handleChallengeToggle}
          onSiege={handleSiegeToggle}
          marchMode={marchMode}
          banditMode={banditMode}
          challengeMode={challengeMode}
          siegeMode={siegeMode}
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
