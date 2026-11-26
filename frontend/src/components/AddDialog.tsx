import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/format';
import { MAX_URLS, urlLines, validateURLs } from '../lib/validation';
import { useTaskStore } from '../store/tasks';
import { Icon } from './Icon';

interface Props { open: boolean; onClose(): void; onAdded(count: number): void }

export function AddDialog({ open, onClose, onAdded }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const segmentInput = useRef<HTMLInputElement>(null);
  const session = useRef(0);
  const settings = useTaskStore((state) => state.settings);
  const connected = useTaskStore((state) => state.connection === 'connected');
  const [urls, setURLs] = useState('');
  const [directory, setDirectory] = useState('');
  const [segments, setSegments] = useState<string | null>(null);
  const [segmentError, setSegmentError] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [rejections, setRejections] = useState<{ url: string; error: string }[]>([]);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const count = urlLines(urls).length;
  const defaultSegments = settings?.segmentsPerFile;
  const segmentValue = segments ?? String(typeof defaultSegments === 'number' && Number.isInteger(defaultSegments) && defaultSegments >= 1 && defaultSegments <= 32 ? defaultSegments : 8);

  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    session.current++;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    input.current?.focus();
    return () => {
      session.current++;
      element.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  async function pickDirectory() {
    setPicking(true);
    setOperationError(null);
    try {
      const chosen = await api.pickDirectory();
      if (chosen) setDirectory(chosen);
    } catch (error) { setOperationError(errorMessage(error)); }
    finally { setPicking(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || picking || !connected) return;
    const validation = validateURLs(urls);
    const segmentCount = Number(segmentValue);
    const invalidSegments = !segmentValue.trim() || !Number.isInteger(segmentCount) || segmentCount < 1 || segmentCount > 32;
    setSegmentError(invalidSegments);
    setValidationErrors(validation.errors);
    setOperationError(null);
    setRejections([]);
    setAccepted(0);
    if (validation.errors.length) { input.current?.focus(); return; }
    if (invalidSegments) { segmentInput.current?.focus(); return; }
    setSubmitting(true);
    const submittedSession = session.current;
    try {
      const result = await api.addURLs({ urls: validation.urls, saveDir: directory, segments: segmentCount });
      if (result.ids.length) onAdded(result.ids.length);
      if (result.errors.length) {
        setAccepted(result.ids.length);
        setRejections(result.errors);
        // Only rejected URLs remain, so retrying cannot duplicate accepted downloads.
        setURLs(result.errors.map((item) => item.url).join('\n'));
      } else if (result.ids.length) {
        setURLs('');
        if (submittedSession === session.current) onClose();
      } else { setOperationError('Chưa có URL nào được thêm. Vui lòng kiểm tra và thử lại.'); }
    } catch (error) { setOperationError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }

  return (
    <dialog ref={dialog} className="add-dialog" aria-labelledby="add-title" aria-describedby="add-description"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog-heading">
        <span className="dialog-symbol"><Icon name="link" size={24} /></span>
        <button type="button" className="icon-button" aria-label="Đóng hộp thoại" onClick={onClose}><Icon name="close" /></button>
      </div>
      <h2 id="add-title">Thêm đường dẫn tải</h2>
      <p id="add-description" className="muted">Một đường dẫn hay cả danh sách. GoGet sẵn sàng.</p>
      <form onSubmit={(event) => { void submit(event); }} noValidate>
        <div className="field-heading">
          <label htmlFor="download-urls">URL tải xuống</label>
          <span className={count > MAX_URLS ? 'url-count over-limit' : 'url-count'}>{count}/{MAX_URLS} URL</span>
        </div>
        <textarea ref={input} id="download-urls" value={urls} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          placeholder={'https://example.com/tai-lieu.pdf\nhttps://example.com/bo-suu-tap.zip'}
          onChange={(event) => { setURLs(event.target.value); setValidationErrors([]); }}
          disabled={submitting} aria-invalid={validationErrors.length > 0}
          aria-describedby={`url-hint${validationErrors.length ? ' url-errors' : ''}`} />
        <p className="field-hint" id="url-hint">Mỗi dòng một URL http:// hoặc https://. Tối đa 100 đường dẫn.</p>
        {validationErrors.length > 0 && <ul className="form-errors" id="url-errors" role="alert">{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul>}
        <label htmlFor="save-directory" className="directory-label">Thư mục lưu</label>
        <div className="directory-picker">
          <Icon name="folder" />
          <output id="save-directory" title={directory || settings?.downloadDir}>{directory || settings?.downloadDir || 'Thư mục tải xuống mặc định'}</output>
          <button type="button" className="button button-small button-outline" onClick={() => { void pickDirectory(); }} disabled={picking || submitting || !connected}>
            {picking ? 'Đang chọn…' : 'Chọn thư mục'}
          </button>
        </div>
        <p className="field-hint">{directory ? 'Thư mục đã được chọn qua hộp thoại hệ thống.' : 'Sử dụng thư mục mặc định của ứng dụng.'}</p>
        <div className="segment-setting">
          <div><label htmlFor="download-segments">Số đoạn</label><p className="field-hint" id="segments-hint">Mỗi tệp từ 1 đến 32 đoạn. Máy chủ có thể chỉ hỗ trợ tải một luồng.</p></div>
          <input ref={segmentInput} id="download-segments" type="number" min={1} max={32} step={1} inputMode="numeric" value={segmentValue}
            onChange={(event) => { setSegments(event.target.value); setSegmentError(false); }} disabled={submitting}
            aria-invalid={segmentError} aria-describedby={`segments-hint${segmentError ? ' segments-error' : ''}`} />
        </div>
        {segmentError && <p role="alert" className="form-errors" id="segments-error">Số đoạn phải là số nguyên từ 1 đến 32.</p>}
        {!connected && <p role="alert" className="form-errors">Mất kết nối với ứng dụng. Hãy kết nối lại trước khi thêm URL.</p>}
        {operationError && <p role="alert" className="form-errors">{operationError}</p>}
        {accepted > 0 && <p role="status" className="form-success">Đã thêm {accepted} URL. Các đường dẫn bên dưới cần được kiểm tra lại.</p>}
        {rejections.length > 0 && <div className="rejections" role="alert"><strong>Không thể thêm {rejections.length} URL</strong><ul>{rejections.map((item, index) => <li key={`${index}-${item.url}`}><span dir="auto">{item.url}</span><p>{item.error}</p></li>)}</ul></div>}
        <div className="dialog-footer">
          <span className="dialog-footnote"><Icon name="download" size={16} /> Tải trực tiếp về máy của bạn</span>
          <div className="dialog-actions">
            <button type="button" className="button button-outline" onClick={onClose}>Đóng</button>
            <button className="button button-primary" type="submit" disabled={submitting || picking || !connected}>
              {submitting ? <span className="spinner" /> : <Icon name="arrow" size={18} />}
              {submitting ? 'Đang thêm…' : 'Bắt đầu tải'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
