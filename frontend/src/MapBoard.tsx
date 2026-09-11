import { useMemo } from 'react';
import type { Side, Terrain, WorldArmy, WorldStateResponse } from '@mygame/shared';

/** 格子上的地图标记：城池/野地/部队 */
export interface BoardMarker {
  kind: 'city' | 'bandit' | 'army';
  side?: Side;
  label: string;
  /** 城池标记对应的城池 id（攻城入口用；非城池标记为空） */
  cityId?: string;
  /** 城池名称（攻城结果/入口展示用） */
  cityName?: string;
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

/** 标记样式类：城池/野地/部队 × 我方/敌方 */
function markerClass(marker: BoardMarker): string {
  if (marker.kind === 'bandit') {
    return 'mk-bandit mg-glow-bandit';
  }
  return `mk-${marker.kind}-${marker.side === 'me' ? 'me' : 'enm'}`;
}

/** 把世界状态中的城池/野地/部队落位到网格（同格多层标记：城在角、部队居中） */
export function buildCells(world: WorldStateResponse): MapCell[] {
  const { width, height } = world.world;
  const byKey = new Map<string, BoardMarker[]>();
  const push = (key: string, marker: BoardMarker) => {
    const list = byKey.get(key) ?? [];
    list.push(marker);
    byKey.set(key, list);
  };
  for (const c of world.cities) {
    push(`${c.x},${c.y}`, {
      kind: 'city',
      side: c.side,
      label: c.side === 'me' ? '城' : '敌城',
      cityId: c.id,
      cityName: c.name,
    });
  }
  for (const wl of world.wildlands) {
    push(`${wl.x},${wl.y}`, { kind: 'bandit', label: '野' });
  }
  for (const a of world.armies) {
    push(`${a.x},${a.y}`, {
      kind: 'army',
      side: a.side,
      label: a.side === 'me' ? '军' : '敌',
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

/** 描述选中格（状态栏展示用） */
export function describeCell(cell: MapCell): string {
  const terrain = TERRAIN_NAMES[cell.terrain];
  const labels = cell.markers.map((m) => m.label);
  return `(${cell.x},${cell.y}) ${terrain}${labels.length > 0 ? ` · ${labels.join(' / ')}` : ''}`;
}

interface MapBoardProps {
  world: WorldStateResponse;
  onCellClick(cell: MapCell): void;
  /** 点击我方部队时回调（用于选择行军队列） */
  onArmyClick?(army: WorldArmy): void;
  /** 当前被选为行军出发的部队 id（高亮） */
  selectedArmyId?: string | null;
}

/** 中央棋盘：DOM 网格渲染地形，叠加城池/野地/部队标记 */
export function MapBoard({ world, onCellClick, onArmyClick, selectedArmyId }: MapBoardProps) {
  const cells = useMemo(() => buildCells(world), [world]);
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
                  e.stopPropagation();
                  if (marker.army && marker.army.side === 'me' && onArmyClick) {
                    onArmyClick(marker.army);
                  }
                }}
                title={marker.army ? `${marker.army.generalName}${marker.marching ? '（行军途中）' : ''}` : undefined}
              >
                {marker.label}
              </span>
            );
          })}
        </button>
      ))}
    </div>
  );
}