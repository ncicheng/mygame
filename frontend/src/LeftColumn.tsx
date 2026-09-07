import type { General, UserProfile } from '@mygame/shared';

interface LeftColumnProps {
  user: UserProfile;
}

/** 兵种等级上限（1-15 级）与武器阶数上限（1-20 阶），养成进度条用 */
const SOLDIER_LEVEL_MAX = 15;
const WEAPON_TIER_MAX = 20;

/** 左卡片栏：武将卡 + 部队编成卡 + 养成卡 */
export function LeftColumn({ user }: LeftColumnProps) {
  const general: General | undefined = user.generals[0];
  if (!general) {
    return <section className="card">尚无武将</section>;
  }
  const troopCount = general.army.reduce((sum, unit) => sum + unit.count, 0);
  const maxSoldierLevel = general.army.reduce((max, unit) => Math.max(max, unit.soldierLevel), 0);
  const weaponTier = general.weapon?.tier ?? 0;

  return (
    <>
      <section className="card gcard">
        <div className="portrait">🏮</div>
        <div className="meta">
          <b>{general.name}</b>
          Lv.{general.level}
          <br />
          带兵 {troopCount}
          <br />
          武器 {general.weapon ? `${general.weapon.name}（${general.weapon.tier} 阶）` : '未装备'}
        </div>
      </section>

      <section className="card">
        <h4>⚒ 部队编成</h4>
        {general.army.length === 0 ? (
          <div className="trow"><span>暂无兵卒</span></div>
        ) : (
          general.army.map((unit, i) => (
            <div className="trow" key={i}>
              <span>{unit.soldierType} Lv.{unit.soldierLevel}</span>
              <span className="n">×{unit.count}</span>
            </div>
          ))
        )}
        <div className="trow">
          <span>武器</span>
          <span className="n">{general.weapon ? `${general.weapon.name} (${general.weapon.tier}阶)` : '—'}</span>
        </div>
      </section>

      <section className="card">
        <h4>🎖 养成</h4>
        <div className="trow">
          <span>兵种解锁</span>
          <span className="n">{maxSoldierLevel}/{SOLDIER_LEVEL_MAX}</span>
        </div>
        <div className="bar">
          <i style={{ width: `${Math.round((maxSoldierLevel / SOLDIER_LEVEL_MAX) * 100)}%` }} />
        </div>
        <div className="trow">
          <span>武器强化</span>
          <span className="n">{weaponTier}/{WEAPON_TIER_MAX}</span>
        </div>
        <div className="bar">
          <i style={{ width: `${Math.round((weaponTier / WEAPON_TIER_MAX) * 100)}%` }} />
        </div>
      </section>
    </>
  );
}