package signin

import (
	"net/netip"
	"testing"

	"maunium.net/go/mautrix/bridgev2"
)

func cookieField(id string, required bool, domain string) bridgev2.LoginCookieField {
	return bridgev2.LoginCookieField{ID: id, Required: required, Sources: []bridgev2.LoginCookieFieldSource{
		{Type: bridgev2.LoginCookieTypeCookie, Name: id, CookieDomain: domain},
	}}
}

func TestCollectorCookiesAndURL(t *testing.T) {
	c := newCollector(&bridgev2.LoginCookiesParams{
		WaitForURLPattern: `^https://www\.facebook\.com/(?:\?.*)?$`,
		Fields:            []bridgev2.LoginCookieField{cookieField("xs", true, "facebook.com"), cookieField("datr", true, "facebook.com"), cookieField("opt", false, "")},
	})
	cookies := []cookie{
		{Name: "xs", Value: "elsewhere", Domain: ".notfacebook.com"},
		{Name: "xs", Value: "sub", Domain: "m.facebook.com"},
		{Name: "xs", Value: "own", Domain: ".facebook.com"},
		{Name: "datr", Value: "d", Domain: ".facebook.com"},
	}
	values, complete := c.collect(cookies, nil, "https://www.facebook.com/login/")
	if complete {
		t.Error("complete before the page is where the step waits for")
	}
	if values["xs"] != "own" || values["datr"] != "d" {
		t.Errorf("values = %v", values)
	}
	if _, ok := values["opt"]; ok {
		t.Error("an optional field with no value was given one")
	}
	if _, complete = c.collect(cookies, nil, "https://www.facebook.com/?sk=h"); !complete {
		t.Error("not complete with every cookie, on the page waited for")
	}
	if _, complete = c.collect(cookies[:3], nil, "https://www.facebook.com/"); complete {
		t.Error("complete without a required cookie")
	}
	// A subdomain's cookie does when the domain's own isn't there.
	values, _ = c.collect(cookies[:2], nil, "")
	if values["xs"] != "sub" {
		t.Errorf("xs = %q, want the subdomain's", values["xs"])
	}
}

func TestCollectorRequestsAndScript(t *testing.T) {
	c := newCollector(&bridgev2.LoginCookiesParams{URL: "https://www.linkedin.com/login", Fields: []bridgev2.LoginCookieField{
		{ID: "cookie_header", Required: true, Pattern: `\bli_at=`, Sources: []bridgev2.LoginCookieFieldSource{
			{Type: bridgev2.LoginCookieTypeRequestHeader, Name: "Cookie", RequestURLRegex: `^https://www\.linkedin\.com/`},
		}},
		{ID: "auth_token", Required: true, Pattern: `^xoxc-`, Sources: []bridgev2.LoginCookieFieldSource{
			{Type: bridgev2.LoginCookieTypeSpecial, Name: "fi.mau.slack.auth_token"},
			{Type: bridgev2.LoginCookieTypeRequestBody, Name: "token", RequestURLRegex: `^https://.+?\.linkedin\.com/api/`},
		}},
		{ID: "castle", Required: true, Sources: []bridgev2.LoginCookieFieldSource{
			{Type: bridgev2.LoginCookieTypeSpecial, Name: "castle"},
			{Type: bridgev2.LoginCookieTypeLocalStorage, Name: "castle_key"},
		}},
	}})
	c.request("https://www.linkedin.com/feed", map[string]string{"cookie": "JSESSIONID=guest"}, "https://www.linkedin.com/feed")
	c.request("https://evil.example/https://www.linkedin.com/", map[string]string{"Cookie": "li_at=stolen"}, "https://www.linkedin.com/feed")
	if values, _ := c.collect(nil, nil, "https://www.linkedin.com/feed"); values["cookie_header"] != "" {
		t.Errorf("cookie_header = %q from a request that doesn't match, or a value that doesn't", values["cookie_header"])
	}
	c.request("https://www.linkedin.com/voyager", map[string]string{"Cookie": "JSESSIONID=x; li_at=real"}, "https://www.linkedin.com/feed")

	body := "--b\r\nContent-Disposition: form-data; name=\"token\"\r\n\r\nxoxc-123\r\n--b--\r\n"
	c.request("https://www.linkedin.com/api/client.boot", map[string]string{"Content-Type": "multipart/form-data; boundary=b"}, body)
	values, complete := c.collect(nil, map[string]string{"castle_key": "from-storage"}, "https://www.linkedin.com/feed")
	if !complete || values["cookie_header"] != "JSESSIONID=x; li_at=real" || values["auth_token"] != "xoxc-123" || values["castle"] != "from-storage" {
		t.Errorf("values = %v, complete %v", values, complete)
	}
	// What the script resolves comes first.
	c.extract(map[string]any{"auth_token": "xoxc-script", "castle": "script", "ignored": map[string]any{}})
	if values, _ = c.collect(nil, map[string]string{"castle_key": "from-storage"}, "https://www.linkedin.com/feed"); values["auth_token"] != "xoxc-script" || values["castle"] != "script" {
		t.Errorf("values = %v", values)
	}
	c.wipe()
	if values, _ = c.collect(nil, nil, "https://www.linkedin.com/feed"); len(values) != 0 {
		t.Errorf("after wipe: %v", values)
	}
}

func TestParseBody(t *testing.T) {
	if got := parseBody("application/json", `{"token":"a","n":1,"o":{}}`); got["token"] != "a" || got["n"] != "1" || got["o"] != "" {
		t.Errorf("json: %v", got)
	}
	if got := parseBody("application/x-www-form-urlencoded", "token=a%2Bb&x=1"); got["token"] != "a+b" {
		t.Errorf("form: %v", got)
	}
}

func TestMakeUserAgent(t *testing.T) {
	own := "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.7444.59 Safari/537.36"
	ua := makeUserAgent("", own)
	if ua.value != "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36" {
		t.Errorf("user agent %q", ua.value)
	}
	if ua.metadata["fullVersion"] != "142.0.7444.59" || ua.metadata["platform"] != "Linux" {
		t.Errorf("metadata %v", ua.metadata)
	}
	step := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
	if ua = makeUserAgent(step, own); ua.value != step || ua.metadata["platform"] != "Windows" || ua.metadata["fullVersion"] != "141.0.0.0" {
		t.Errorf("step's user agent: %q %v", ua.value, ua.metadata)
	}
}

func TestCollectorStaysOnTheStepsSite(t *testing.T) {
	// X's cookie step names no cookie domain and no page to wait for.
	c := newCollector(&bridgev2.LoginCookiesParams{URL: "https://x.com/i/flow/login", Fields: []bridgev2.LoginCookieField{
		cookieField("ct0", true, ""), cookieField("auth_token", true, ""),
	}})
	elsewhere := []cookie{{Name: "ct0", Value: "a", Domain: ".evil.example"}, {Name: "auth_token", Value: "b", Domain: "evil.example"}}
	if values, complete := c.collect(elsewhere, nil, "https://x.com/home"); complete || len(values) != 0 {
		t.Errorf("another site's cookies were taken: %v %v", values, complete)
	}
	own := []cookie{{Name: "ct0", Value: "a", Domain: ".x.com"}, {Name: "auth_token", Value: "b", Domain: "x.com"}}
	if _, complete := c.collect(own, nil, "https://evil.example/"); complete {
		t.Error("complete while the browser is on another site")
	}
	if values, complete := c.collect(own, nil, "https://x.com/home"); !complete || values["ct0"] != "a" {
		t.Errorf("x.com's own cookies: %v %v", values, complete)
	}
}

func TestCollectorDecodesCookiesBeforeMatching(t *testing.T) {
	// Slack's d cookie, as a browser keeps it: percent-encoded, which its pattern doesn't allow.
	c := newCollector(&bridgev2.LoginCookiesParams{URL: "https://slack.com/signin", Fields: []bridgev2.LoginCookieField{{
		ID: "cookie_token", Required: true, Pattern: `^xoxd-[a-zA-Z0-9/+=]+$`,
		Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeCookie, Name: "d", CookieDomain: "slack.com"}},
	}}})
	values, complete := c.collect([]cookie{{Name: "d", Value: "xoxd-ab%2Fc%2Bd%3D%3D", Domain: ".slack.com"}}, nil, "https://app.slack.com/client")
	if !complete || values["cookie_token"] != "xoxd-ab/c+d==" {
		t.Errorf("values = %v, complete %v", values, complete)
	}
}

func TestFromBrowser(t *testing.T) {
	if FromBrowser("http://127.0.0.1:9222")(netip.MustParseAddr("127.0.0.1")) {
		t.Error("a launcher on loopback refuses loopback")
	}
	refuse := FromBrowser("http://10.9.8.7:9222")
	if !refuse(netip.MustParseAddr("10.9.8.7")) || !refuse(netip.MustParseAddr("::ffff:10.9.8.7")) || refuse(netip.MustParseAddr("10.9.8.6")) {
		t.Error("an address launcher refuses the wrong addresses")
	}
	if FromBrowser("http://localhost:9222")(netip.MustParseAddr("127.0.0.1")) {
		t.Error("localhost is refused")
	}
}

func TestCollectorTakesRequestsOnlyFromTheStepsSite(t *testing.T) {
	// LinkedIn's own field, with its own unanchored URL pattern.
	c := newCollector(&bridgev2.LoginCookiesParams{URL: "https://linkedin.com/login", Fields: []bridgev2.LoginCookieField{{
		ID: "fi.mau.linkedin.login.cookie_header", Required: true, Pattern: `\bJSESSIONID=[^;]+`,
		Sources: []bridgev2.LoginCookieFieldSource{{Type: bridgev2.LoginCookieTypeRequestHeader, Name: "Cookie", RequestURLRegex: `https://www.linkedin.com`}},
	}}})
	c.request("https://evil.example/track?from=https://www.linkedin.com", map[string]string{"Cookie": "JSESSIONID=planted"}, "")
	if values, _ := c.collect(nil, nil, "https://www.linkedin.com/feed/"); len(values) != 0 {
		t.Errorf("a request to another site was taken: %v", values)
	}
	c.request("https://www.linkedin.com/voyager/api/me", map[string]string{"Cookie": "JSESSIONID=real; li_at=x"}, "")
	if values, complete := c.collect(nil, nil, "https://www.linkedin.com/feed/"); !complete || values["fi.mau.linkedin.login.cookie_header"] != "JSESSIONID=real; li_at=x" {
		t.Errorf("values = %v, complete %v", values, complete)
	}
}
