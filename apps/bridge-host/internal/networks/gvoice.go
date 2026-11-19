package networks

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	gvoice "go.mau.fi/mautrix-gvoice/pkg/connector"
	"go.mau.fi/mautrix-gvoice/pkg/libgv"
	"maunium.net/go/mautrix/bridgev2"
)

func init() {
	register("gvoice", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn, err := withDefaults("Google Voice", &gvoice.GVConnector{})
			if err != nil {
				return nil, err
			}
			return &gvoiceConnector{conn.(*gvoice.GVConnector)}, nil
		},
	})
}

// gvoiceConnector is mautrix-gvoice with one change: a text is never sent twice. libgv
// repeats any request that fails with a network error or a 5xx, up to 11 times
// (libgv/request.go, MakeRequest), sending SMS included, so a send whose outcome is
// ambiguous (the connection dropped after Google got it) would go out again. Everything else
// is the connector's own: the embedded pointer keeps every optional interface it implements.
type gvoiceConnector struct {
	*gvoice.GVConnector
}

func (gv *gvoiceConnector) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	if err := gv.GVConnector.LoadUserLogin(ctx, login); err != nil {
		return err
	}
	if client, ok := login.Client.(*gvoice.GVClient); ok && client.Client != nil && client.Client.HTTP != nil {
		client.Client.HTTP.Transport = &gvoiceSendOnce{next: client.Client.HTTP.Transport}
	}
	return nil
}

var gvoiceSendSMS, _ = url.Parse(libgv.EndpointSendSMS)

// gvoiceSendOnce makes an ambiguous failure of a send final. libgv only gives up on a
// request without retrying when it gets a response under 500, and the HTTP client wraps
// every transport error as a net.Error, which libgv retries; so a send that failed in
// transport or with a 5xx comes back as 408 Request Timeout. The connector reports that as
// a timeout it isn't certain about, which the bridge host records as unknown.
type gvoiceSendOnce struct {
	next http.RoundTripper
}

func (t *gvoiceSendOnce) RoundTrip(req *http.Request) (*http.Response, error) {
	next := t.next
	if next == nil {
		next = http.DefaultTransport
	}
	if req.URL.Host != gvoiceSendSMS.Host || req.URL.Path != gvoiceSendSMS.Path {
		return next.RoundTrip(req)
	}
	resp, err := next.RoundTrip(req)
	if err == nil && resp.StatusCode < 500 {
		return resp, nil
	}
	// A transport error includes the HTTP client's own 2-minute timeout, which libgv would
	// retry: Google may well have the send by then.
	reason := "transport error"
	if err == nil {
		reason = fmt.Sprintf("status %d", resp.StatusCode)
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
		_ = resp.Body.Close()
	}
	return &http.Response{
		Status:     "408 Request Timeout (Trioditis: send not repeated after " + reason + ")",
		StatusCode: http.StatusRequestTimeout,
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader("")),
		Request:    req,
	}, nil
}
