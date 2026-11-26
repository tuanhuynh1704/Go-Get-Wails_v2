import type { Filter } from '../lib/types';
import { useTaskStore } from '../store/tasks';
import { Icon, type IconName } from './Icon';

export const filterLabels: Record<Filter, string> = {
  all: 'Tất cả', downloading: 'Đang tải', completed: 'Hoàn tất', failed: 'Thất bại',
};

const links: { id: Filter; icon: IconName }[] = [
  { id: 'all', icon: 'grid' }, { id: 'downloading', icon: 'download' },
  { id: 'completed', icon: 'check' }, { id: 'failed', icon: 'alert' },
];

export function Sidebar({ filter, onFilter }: { filter: Filter; onFilter(filter: Filter): void }) {
  const ids = useTaskStore((state) => state.filterIDs);
  const connection = useTaskStore((state) => state.connection);
  return (
    <aside className="sidebar">
      <a className="brand" href="#main" aria-label="GOGET, đến nội dung chính"><span className="brand-mark"><Icon name="download" size={23} /></span><span>GOGET<span className="brand-period">.</span></span></a>
      <div className="sidebar-section-label">THƯ VIỆN CỦA BẠN</div>
      <nav className="filter-nav" aria-label="Lọc tác vụ">
        {links.map(({ id, icon }) => (
          <button key={id} type="button" className={`filter-button ${filter === id ? 'is-selected' : ''}`} aria-current={filter === id ? 'page' : undefined} onClick={() => onFilter(id)}>
            <Icon name={icon} size={19} /><span>{filterLabels[id]}</span><span className="filter-count">{connection === 'connected' || ids.all.length ? ids[id].length : '—'}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="note-line" /><p>Mọi đường dẫn.<br /><strong>Một điểm đến.</strong></p><Icon name="arrow" size={22} /></div>
        <div className="sidebar-version"><span>GOGET DESKTOP</span><span>v0.1</span></div>
      </div>
    </aside>
  );
}
