import { useMemo } from 'react';
import type { Side, Terrain, WorldArmy, WorldStateResponse } from '@mygame/shared';

/** 格子上的地图标记：城池/野地/部队 */
export interface BoardMarker {
  kind: 'city' | 'bandit' | 'army';
  /** me=我方；friend=同军团友军；enemy=敌方 */
  side?: Side | 'friend';
  label: string;
  /** 城池标记对应的城池 id（攻城入口用；非城池标记为空） */
  cityId?: string;
  /** 城池名称（攻城结果/入口展示用） */
  cityName?: string;
  /** 拥有者昵称（城池/部队；野地为空） */
  ownerName?: string | null;
  /** 拥有者 user_id（城池/部队；用于判断同军团友军） */
  ownerUserId?: string;
  /** 拥有者武将等级（城池/部队；野地为空） */
  ownerLevel?: number | null;
  /** 野地名称（野地标记用） */
  wildlandName?: string;
  /** 野地强度（野地标记用） */
  wildlandStrength?: number;
  /** 部队标记对应的大地图部队（用于选中行军队列） */
  army?: WorldArmy;
  /** 部队是否正在行军 */
  marching?: boolean;
}

/** 世界格：坐标 + 地形 + 该格上的标记 */
export interface MapCell {
  x: number;
  y: number;
  terrain: Terrain;
  markers: BoardMarker[];
}

/** 地形代码 → 中文名 */
export const TERRAIN_NAMES: Record<Terrain, string> = {
  g: '平原',
  f: '林地',
  m: '山地',
  w: '水域',
};

/** 标记样式类：城池/野地/部队 × 我方/友方/敌方 */
function markerClass(marker: BoardMarker): string {
  if (marker.kind === 'bandit') {
    return 'mk-bandit mg-glow-bandit';
  }
  return `mk-${marker.kind}-${marker.side === 'me' ? 'me' : marker.side === 'friend' ? 'fr' : 'enm'}`;
}

/** 把世界状态中的城池/野地/部队落位到网格（同格多层标记：城在角、部队居中）。
 * friendUserIds：当前玩家所在军团成员 id 集合，用于把同军团玩家的单位标记为「友」。 */
export function buildCells(world: WorldStateResponse, friendUserIds: Set<string> = new Set()): MapCell[] {
  const { width, height } = world.world;
  const byKey = new Map<string, BoardMarker[]>();
  const push = (key: string, marker: BoardMarker) => {
    const list = byKey.get(key) ?? [];
    list.push(marker);
    byKey.set(key, list);
  };
  for (const c of world.cities) {
    const owner = c.ownerUserId;
    const side = owner == null ? c.side : owner === c.side && c.side === 'me' ? 'me' : friendUserIds.has(owner) ? 'friend' : 'enemy';
    push(`${c.x},${c.y}`, {
      kind: 'city',
      side,
      label: side === 'me' ? '城' : side === 'friend' ? '友城' : '敌城',
      cityId: c.id,
      cityName: c.name,
      ownerUserId: c.ownerUserId,
      ownerName: c.ownerName ?? null,
      ownerLevel: c.ownerLevel ?? null,
    });
  }
  for (const wl of world.wildlands) {
    push(`${wl.x},${wl.y}`, {
      kind: 'bandit',
      label: '野',
      wildlandName: wl.name,
      wildlandStrength: wl.strength,
    });
  }
  for (const a of world.armies) {
    const owner = a.ownerUserId;
    const side = owner == null ? a.side : a.side === 'me' ? 'me' : friendUserIds.has(owner) ? 'friend' : 'enemy';
    push(`${a.x},${a.y}`, {
      kind: 'army',
      side,
      label: side === 'me' ? '军' : side === 'friend' ? '友' : '敌',
      army: a,
      marching: a.march !== null,
    });
  }

  const cells: MapCell[] = [];
  for (let y = 0; y < height; y++) {
    const row = world.tiles[y] ?? '';
    for (let x = 0; x < width; x++) {
      cells.push({
        x,
        y,
        terrain: (row[x] as Terrain) ?? 'g',
        markers: byKey.get(`${x},${y}`) ?? [],
      });
    }
  }
  return cells;
}

/** 描述选中格（状态栏展示用）：含拥有者/等级/兵力/野地强度等详细信息 */
export function describeCell(cell: MapCell): string {
  const terrain = TERRAIN_NAMES[cell.terrain];
  const details = cell.markers.map((m) => {
    if (m.kind === 'army') {
      const lv = m.army?.generalLevel != null ? ` Lv.${m.army.generalLevel}` : '';
      const troop = m.army ? ` · 兵力 ${m.army.troopCount.toLocaleString()}` : '';
      return `${m.label}${ownerLine(m) ? ` ${ownerLine(m)}` : ''}${lv}${troop}`;
    }
    if (m.kind === 'city') {
      return `${m.label}${ownerLine(m) ? ` ${ownerLine(m)}` : ''}${m.cityName ? `（${m.cityName}）` : ''}`;
    }
    if (m.kind === 'bandit') {
      return `${m.label}${m.wildlandName ? ` ${m.wildlandName}` : ''}${m.wildlandStrength != null ? ` 强度${m.wildlandStrength}` : ''}`;
    }
    return m.label;
  });
  return `(${cell.x},${cell.y}) ${terrain}${details.length > 0 ? ` · ${details.join(' / ')}` : ''}`;
}

/** 拥有者展示：昵称 + 等级；缺失时返回空串 */
export function ownerLine(marker: BoardMarker): string {
  const parts: string[] = [];
  if (marker.ownerName) parts.push(marker.ownerName);
  if (marker.ownerLevel != null) parts.push(`Lv.${marker.ownerLevel}`);
  return parts.join(' · ');
}

interface MapBoardProps {
  world: WorldStateResponse;
  /** 同军团成员 user_id 集合（用于把友军标记为「友」） */
  friendUserIds?: Set<string>;
  onCellClick(cell: MapCell): void;
  /** 点击我方部队时回调（用于选择行军队列） */
  onArmyClick?(army: WorldArmy): void;
  /** 当前被选为行军出发的部队 id（高亮） */
  selectedArmyId?: string | null;
}

/** 中央棋盘：DOM 网格渲染地形，叠加城池/野地/部队标记 */
export function MapBoard({ world, friendUserIds, onCellClick, onArmyClick, selectedArmyId }: MapBoardProps) {
  const cells = useMemo(() => buildCells(world, friendUserIds), [world, friendUserIds]);
  const { width, height } = world.world;
  const cellSize = 30;
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${width}, ${cellSize}px)`,
        gridTemplateRows: `repeat(${height}, ${cellSize}px)`,
      }}
    >
      {cells.map((cell) => (
        <button
          type="button"
          key={`${cell.x},${cell.y}`}
          className={`cell terr-${cell.terrain}`}
          onClick={() => onCellClick(cell)}
          title={`(${cell.x},${cell.y}) ${TERRAIN_NAMES[cell.terrain]}`}
        >
          {cell.markers.map((marker, i) => {
            const classes = [
              'mk',
              markerClass(marker),
              marker.army && marker.army.march ? 'mk-marching' : '',
              marker.army && marker.army.id === selectedArmyId ? 'mk-selected' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <span
                key={i}
                className={classes}
                onClick={(e) => {
                  // 仅「我军」标记拦截点击（用于选中行军队列）；其余标记（野地/城池/敌方）
                  // 不拦截，让事件冒泡到格子按钮，由 onCellClick 统一处理选中/出征/打野/挑战/攻城。
                  if (marker.army && marker.army.side === 'me') {
                    e.stopPropagation();
                    if (onArmyClick) onArmyClick(marker.army);
                  }
                }}
                title={
                  marker.army
                    ? `${marker.army.generalName}${marker.army.generalLevel != null ? ` Lv.${marker.army.generalLevel}` : ''} · 兵力 ${marker.army.troopCount.toLocaleString()}\n${ownerLine(marker) || '未知玩家'}${marker.marching ? '\n（行军途中）' : ''}`
                    : marker.kind === 'city'
                      ? `${marker.cityName ?? '城池'}\n${ownerLine(marker) || '未知玩家'}`
                      : marker.kind === 'bandit'
                        ? `${marker.wildlandName ?? '山贼营地'} · 强度 ${marker.wildlandStrength ?? '?'}\n击败掉落稀有材料`
                        : undefined
                }
              >
                {marker.label}
                {(marker.kind === 'army' || marker.kind === 'city') && marker.ownerLevel != null && (
                  <em className="mk-lv">{marker.ownerLevel}</em>
                )}
              </span>
            );
          })}
        </button>
      ))}
    </div>
  );
}