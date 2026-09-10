import { useState } from 'react';
import type { General } from '@mygame/shared';
import {
  GENERAL_LEVEL_MAX,
  GENERAL_STAR_MAX,
  TROOP_LEVEL_MAX,
  WEAPON_TIER_MAX,
  generalLevelUpCost,
  generalStarUpCost,
  getTroopType,
  troopUnlockCost,
  weaponUpgradeCost,
} from '@mygame/shared';
import { levelUpGeneral, starUpGeneral, unlockTroop, upgradeWeapon } from './game';

interface LeftColumnProps {
  userId: string;
  /** 玩家昵称；null 表示尚未设置 */
  nickname: string | null;
  /** 保存昵称：由上层调用 setNickname 并刷新 */
  onSetNickname(name: string): void;
  general: General | null;
  /** 稀有材料余额（用于按钮置灰与成本展示） */
  rare: number;
  /** 已解锁的最高兵种等级 */
  troopMaxUnlocked: number;
  /** 养成成功：由上层刷新世界与玩家数据 */
  onChanged(): void;
}

/** 左卡片栏：昵称卡 + 武将卡 + 部队编成卡 + 养成卡（升级/强化/解锁按钮 + 进度条） */
export function LeftColumn({
  userId,
  nickname,
  onSetNickname,
  general,
  rare,
  troopMaxUnlocked,
  onChanged,
}: LeftColumnProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // 昵称编辑：进入编辑态时以当前昵称为草稿
  const startEditName = () => {
    setEditingName(true);
    setNameDraft(nickname ?? '');
  };
  const saveName = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      // 空输入不做保存，直接退出编辑态（并提供「取消」可随时返回展示态）
      setEditingName(false);
      return;
    }
    onSetNickname(trimmed);
    setEditingName(false);
  };
  const cancelEditName = () => {
    setEditingName(false);
    setNameDraft(nickname ?? '');
  };

  // 昵称卡：展示昵称 + 「修改」入口，编辑态提供输入与保存
  const nicknameCard = (
    <section className="card">
      <h4>🪪 昵称</h4>
      <div className="trow">
        {editingName ? (
          <>
            <input
              className="mg-input"
              placeholder="输入昵称"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
            />
            <button type="button" className="mg-btn ghost" onClick={saveName}>
              保存
            </button>
            <button type="button" className="mg-btn ghost" onClick={cancelEditName}>
              取消
            </button>
          </>
        ) : (
          <>
            <span>{nickname ?? '未设置昵称'}</span>
            <button type="button" className="mg-btn ghost" onClick={startEditName}>
              修改
            </button>
          </>
        )}
      </div>
    </section>
  );

  if (!general) {
    return (
      <>
        {nicknameCard}
        <section className="card">尚无武将</section>
      </>
    );
  }
  const troopCount = general.army.reduce((sum, unit) => sum + unit.count, 0);
  const weaponTier = general.weapon?.tier ?? 0;

  const unlockNext = troopMaxUnlocked + 1;
  const nextTroopName = unlockNext <= TROOP_LEVEL_MAX ? getTroopType(unlockNext)?.name ?? '' : '';

  const run = async (kind: string, action: () => Promise<void>, okMsg: string) => {
    if (busy) {
      return;
    }
    setBusy(kind);
    setMsg(null);
    try {
      await action();
      onChanged();
      setMsg(okMsg);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const generalFull = general.level >= GENERAL_LEVEL_MAX;
  const starFull = (general.stars ?? 1) >= GENERAL_STAR_MAX;
  const weaponFull = weaponTier >= WEAPON_TIER_MAX;
  const troopFull = unlockNext > TROOP_LEVEL_MAX;

  return (
    <>
      {nicknameCard}
      <section className="card gcard">
        <div className="portrait">🏮</div>
        <div className="meta">
          <b>{general.name}</b>
          Lv.{general.level}
          {' ★'.repeat(general.stars ?? 1)}
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

        <div className="prog-row">
          <div>
            <div className="trow">
              <span>武将等级</span>
              <span className="n">Lv.{general.level}/{GENERAL_LEVEL_MAX}</span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.round((general.level / GENERAL_LEVEL_MAX) * 100)}%` }} />
            </div>
          </div>
          <button
            type="button"
            className="prog-btn"
            disabled={busy !== null || generalFull || rare < generalLevelUpCost(general.level)}
            onClick={() => run('lv', () => levelUpGeneral(userId, general.id), '武将升级成功')}
          >
            {generalFull ? '已满级' : `升级 ${generalLevelUpCost(general.level)}稀有`}
          </button>
        </div>

        <div className="prog-row">
          <div>
            <div className="trow">
              <span>武将星级</span>
              <span className="n">★{general.stars ?? 1}/{GENERAL_STAR_MAX}</span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.round(((general.stars ?? 1) / GENERAL_STAR_MAX) * 100)}%` }} />
            </div>
          </div>
          <button
            type="button"
            className="prog-btn"
            disabled={busy !== null || starFull || rare < generalStarUpCost(general.stars ?? 1)}
            onClick={() => run('star', () => starUpGeneral(userId, general.id), '武将升星成功')}
          >
            {starFull ? '已满星' : `升星 ${generalStarUpCost(general.stars ?? 1)}稀有`}
          </button>
        </div>

        <div className="prog-row">
          <div>
            <div className="trow">
              <span>武器强化</span>
              <span className="n">{weaponTier}/{WEAPON_TIER_MAX}</span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.round((weaponTier / WEAPON_TIER_MAX) * 100)}%` }} />
            </div>
          </div>
          <button
            type="button"
            className="prog-btn"
            disabled={busy !== null || weaponFull || rare < weaponUpgradeCost(weaponTier)}
            onClick={() => run('wep', () => upgradeWeapon(userId, general.id), '武器强化成功')}
          >
            {weaponFull ? '已满阶' : `强化 ${weaponUpgradeCost(weaponTier)}稀有`}
          </button>
        </div>

        <div className="prog-row">
          <div>
            <div className="trow">
              <span>兵种解锁</span>
              <span className="n">{troopMaxUnlocked}/{TROOP_LEVEL_MAX}</span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.round((troopMaxUnlocked / TROOP_LEVEL_MAX) * 100)}%` }} />
            </div>
            <div className="trow sub">
              <span>{troopFull ? '全部兵种已解锁' : `下一档：${nextTroopName} Lv.${unlockNext}`}</span>
            </div>
          </div>
          <button
            type="button"
            className="prog-btn"
            disabled={busy !== null || troopFull || rare < troopUnlockCost(unlockNext)}
            onClick={() => run('troop', () => unlockTroop(userId, unlockNext), '兵种解锁成功')}
          >
            {troopFull ? '已全部解锁' : `解锁 ${troopUnlockCost(unlockNext)}稀有`}
          </button>
        </div>

        {msg && <div className="recruit-msg">{msg}</div>}
      </section>
    </>
  );
}
