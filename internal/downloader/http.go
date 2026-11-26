package downloader

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type activityKey struct{}

type transferResponse struct {
	*http.Response
	ctx    context.Context
	cancel context.CancelCauseFunc
	idle   *time.Timer
}

// Each request, including its redirects, owns an independent idle watchdog.
// A busy segment must never keep a stalled sibling alive.
func (m *Manager) request(ctx context.Context, method, rawURL, byteRange, ifRange string) (*transferResponse, error) {
	requestCtx, cancel := context.WithCancelCause(ctx)
	idle := time.AfterFunc(m.idleTimeout, func() { cancel(errIdleTimeout) })
	requestCtx = context.WithValue(requestCtx, activityKey{}, func() { idle.Reset(m.idleTimeout) })
	req, err := http.NewRequestWithContext(requestCtx, method, rawURL, nil)
	if err == nil {
		req.Header.Set("User-Agent", "GoGet/0.2")
		req.Header.Set("Accept-Encoding", "identity")
		if byteRange != "" {
			req.Header.Set("Range", byteRange)
		}
		if ifRange != "" {
			req.Header.Set("If-Range", ifRange)
		}
		var resp *http.Response
		resp, err = m.client.Do(req)
		if err == nil {
			return &transferResponse{Response: resp, ctx: requestCtx, cancel: cancel, idle: idle}, nil
		}
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	if errors.Is(context.Cause(requestCtx), errIdleTimeout) {
		err = errIdleTimeout
	}
	cancel(nil)
	idle.Stop()
	return nil, fmt.Errorf("%s request: %w", method, err)
}

func (r *transferResponse) close() {
	r.cancel(nil)
	_ = r.Body.Close()
	r.idle.Stop()
}

func (r *transferResponse) readError(err error) error {
	if errors.Is(context.Cause(r.ctx), errIdleTimeout) {
		return errIdleTimeout
	}
	if r.ctx.Err() != nil {
		return r.ctx.Err()
	}
	return err
}

func identityEncoding(resp *http.Response) error {
	if encoding := resp.Header.Get("Content-Encoding"); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return fmt.Errorf("unsupported Content-Encoding: %s", encoding)
	}
	if resp.Uncompressed {
		return fmt.Errorf("unsupported Content-Encoding: automatically decompressed response")
	}
	return nil
}

// Track every redirect response, including the bodies drained by http.Client.
// This keeps an idle timeout from becoming a total redirect-chain timeout.
type activityTransport struct{ base http.RoundTripper }

func (t activityTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	touch, _ := req.Context().Value(activityKey{}).(func())
	if touch != nil {
		touch()
	}
	response, err := t.base.RoundTrip(req)
	if err == nil && response != nil && touch != nil {
		touch()
		if response.Body != nil {
			response.Body = activityBody{ReadCloser: response.Body, touch: touch}
		}
	}
	return response, err
}

func (t activityTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

type activityBody struct {
	io.ReadCloser
	touch func()
}

func (b activityBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.touch()
	}
	return n, err
}
