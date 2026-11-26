import { render, screen } from '@testing-library/react';
import { SegmentBar } from './SegmentBar';

describe('segment progress', () => {
  it('renders actual segment count and percentages with individual accessible descriptions', () => {
    render(<SegmentBar fileName="tài-liệu.pdf" segs={[0, 35, 100]} />);
    expect(screen.getByRole('group', { name: 'Tiến trình 3 đoạn của tài-liệu.pdf' })).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(screen.getByRole('progressbar', { name: 'Đoạn 2 của tài-liệu.pdf' })).toHaveAttribute('aria-valuenow', '35');
    expect(screen.getByRole('progressbar', { name: 'Đoạn 2 của tài-liệu.pdf' })).toHaveAttribute('aria-valuetext', 'Đoạn 2/3: 35%');
  });
  it('bounds percentages, handles unknown values and supports 32 cells', () => {
    render(<SegmentBar fileName="file" segs={[-1, 120, Number.NaN, ...Array(29).fill(0)]} />);
    const cells = screen.getAllByRole('progressbar');
    expect(cells).toHaveLength(32);
    expect(cells[0]).toHaveAttribute('aria-valuenow', '0');
    expect(cells[1]).toHaveAttribute('aria-valuenow', '100');
    expect(cells[2]).not.toHaveAttribute('aria-valuenow');
    expect(cells[2]).toHaveAttribute('aria-valuetext', 'Đoạn 3/32: chưa rõ');
  });
  it('does not invent segments while the task is probing', () => {
    const { container } = render(<SegmentBar fileName="file" segs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
