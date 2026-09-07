import type { UserProfile, WorldStateResponse } from '@mygame/shared';

interface RightColumnProps {
  user: UserProfile;
  world: WorldStateResponse;
}

/** 右卡片栏：资源卡 + 战报卡 + 任务卡 + 军团卡 */
export function RightColumn({ user, world }: RightColumnProps) {
  const myCities = world.cities.filter((c) => c.side === 'me').length;
  const { resources } = user;
  return (
    <>
      <section className="card">
        <h4>🗺 资源</h4>
        <div className="trow"><span>粮草</span><span className="n">{resources.food.toLocaleString()}</span></div>
        <div className="trow"><span>铁材</span><span className="n">{resources.iron.toLocaleString()}</span></div>
        <div className="trow"><span>稀有材料</span><span className="n">{resources.rare.toLocaleString()}</span></div>
        <div className="trow"><span>金币</span><span className="n">{resources.gold.toLocaleString()}</span></div>
      </section>

      <section className="card">
        <h4>📜 战报</h4>
        <div className="trow"><span>暂无战报（战斗在任务 6 开放）</span></div>
      </section>

      <section className="card">
        <h4>🏆 任务</h4>
        <div className="trow"><span>暂无任务</span></div>
      </section>

      <section className="card">
        <h4>⛳ 军团</h4>
        <div className="trow"><span>我方城池</span><span className="n">{myCities}</span></div>
        <div className="trow"><span>军团成员</span><span className="n">—</span></div>
      </section>
    </>
  );
}