import { percent } from '../lib/format';

export function SegmentBar({ segs, fileName }: { segs: number[]; fileName: string }) {
  if (!segs.length) return null;
  return <div className="segment-bar" role="group" aria-label={`Tiến trình ${segs.length} đoạn của ${fileName}`} style={{ gridTemplateColumns: `repeat(${segs.length}, minmax(0, 1fr))` }}>
    {segs.map((value, index) => {
      const progress = percent(value, 100);
      const description = `Đoạn ${index + 1}/${segs.length}: ${progress === undefined ? 'chưa rõ' : `${progress}%`}`;
      return <div key={index} className="segment-cell" role="progressbar" aria-label={`Đoạn ${index + 1} của ${fileName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={description} title={description}>
        <span style={{ width: `${progress ?? 0}%` }} />
      </div>;
    })}
  </div>;
}
