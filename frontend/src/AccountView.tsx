import type { UserProfile } from '@mygame/shared';

interface AccountViewProps {
  user: UserProfile;
  onLogout(): void;
}

/** 登录后主界面：资源卡 + 武将卡（武将、部队、武器） */
export function AccountView({ user, onLogout }: AccountViewProps) {
  return (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>主公 {user.username}</h2>
        <button onClick={onLogout}>登出</button>
      </header>

      <section>
        <h3>资源</h3>
        <ul style={{ display: 'flex', gap: '1.5rem', listStyle: 'none', padding: 0, margin: 0 }}>
          <li>粮草：{user.resources.food}</li>
          <li>铁材：{user.resources.iron}</li>
          <li>稀有材料：{user.resources.rare}</li>
          <li>金币：{user.resources.gold}</li>
        </ul>
      </section>

      <section>
        <h3>我的武将</h3>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {user.generals.map((general) => (
            <article
              key={general.id}
              style={{ border: '1px solid #ccc', borderRadius: 8, padding: '0.75rem 1rem' }}
            >
              <h4 style={{ margin: 0 }}>
                {general.name} · Lv.{general.level}
              </h4>
              <p style={{ margin: '0.5rem 0' }}>
                武器：{general.weapon ? `${general.weapon.name}（${general.weapon.tier} 阶）` : '未装备'}
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {general.army.map((unit, i) => (
                  <li key={i}>
                    {unit.soldierType} Lv.{unit.soldierLevel} × {unit.count}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}