import type { CSSProperties } from 'react';

export type IconName = 'download' | 'grid' | 'check' | 'alert' | 'plus' | 'close' | 'folder' | 'arrow' | 'file' | 'clock' | 'stop' | 'link' | 'refresh';
const paths: Record<IconName, React.ReactNode> = {
  download: <><path d="M12 3v12m-5-5 5 5 5-5" /><path d="M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
  grid: <><rect x="3.5" y="3.5" width="6" height="6" rx="1.5" /><rect x="14.5" y="3.5" width="6" height="6" rx="1.5" /><rect x="3.5" y="14.5" width="6" height="6" rx="1.5" /><rect x="14.5" y="14.5" width="6" height="6" rx="1.5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  alert: <><path d="M12 8v5m0 3v.1" /><path d="m10.2 3.6-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.8-2.4l-8-14a2 2 0 0 0-3.6 0Z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  file: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" /><path d="M14 3v5h5M9 13h6m-6 4h4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  stop: <rect x="5" y="5" width="14" height="14" rx="3" />,
  link: <><path d="m10 14 4-4m-6 6-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 8a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-1 1" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" /></>,
};

export function Icon({ name, size = 20, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} style={style}>{paths[name]}</svg>;
}
