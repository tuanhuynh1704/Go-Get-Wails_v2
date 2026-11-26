package downloader

import (
	"io"
	"net/http"
)

type activityKey struct{}

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
