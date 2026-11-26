import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);

// jsdom does not implement the native dialog lifecycle or layout observers.
HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', TestResizeObserver);
