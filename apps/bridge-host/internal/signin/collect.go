package signin

import (
	"encoding/json"
	"fmt"
	"mime"
	"mime/multipart"
	"net/netip"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/publicsuffix"
	"maunium.net/go/mautrix/bridgev2"
)

// collector gathers a cookie step's field values as the browser comes across them, from the
// sources bridgev2 lists for each field (docs/architecture/signin-browser.md, Collecting the
// values). It holds credentials: it lives in memory only, and wipe clears it.
type collector struct {
	fields   []bridgev2.LoginCookieField
	patterns map[string]*regexp.Regexp // by field ID
	urls     map[string]*regexp.Regexp // by source's request URL pattern
	waitFor  *regexp.Regexp
	// site is the step page's registrable domain (x.com for https://x.com/i/flow/login). A
	// cookie source that names no domain is read only from it, and a step with no page to wait
	// for completes only while the browser is on it: a page elsewhere could set cookies of the
	// same names.
	site string
	// seen holds the latest value of each request header and body source, by sourceKey: a
	// page sends a header before signing in and again after, and only the later one is any use.
	seen map[string]string
	// extracted holds what the step's script resolved, by field ID.
	extracted map[string]string
}

type cookie struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Domain string `json:"domain"`
}

func sourceKey(src bridgev2.LoginCookieFieldSource) string {
	return string(src.Type) + "\x00" + strings.ToLower(src.Name) + "\x00" + src.RequestURLRegex
}

func newCollector(params *bridgev2.LoginCookiesParams) *collector {
	c := &collector{
		fields:    params.Fields,
		patterns:  map[string]*regexp.Regexp{},
		urls:      map[string]*regexp.Regexp{},
		seen:      map[string]string{},
		extracted: map[string]string{},
	}
	// The patterns are written for JavaScript; those that Go can't compile are left out
	// rather than blocking the login, since the network checks what it is given anyway.
	if params.WaitForURLPattern != "" {
		c.waitFor, _ = regexp.Compile(params.WaitForURLPattern)
	}
	c.site = siteOf(params.URL)
	for _, f := range params.Fields {
		if f.Pattern != "" {
			if re, err := regexp.Compile(f.Pattern); err == nil {
				c.patterns[f.ID] = re
			}
		}
		for _, src := range f.Sources {
			if src.RequestURLRegex != "" {
				if re, err := regexp.Compile(src.RequestURLRegex); err == nil {
					c.urls[src.RequestURLRegex] = re
				}
			}
		}
	}
	return c
}

// localStorageKeys are the localStorage keys any field reads.
func (c *collector) localStorageKeys() []string {
	var keys []string
	for _, f := range c.fields {
		for _, src := range f.Sources {
			if src.Type == bridgev2.LoginCookieTypeLocalStorage {
				keys = append(keys, src.Name)
			}
		}
	}
	return keys
}

func (c *collector) wantsRequests() bool {
	for _, f := range c.fields {
		for _, src := range f.Sources {
			if src.Type == bridgev2.LoginCookieTypeRequestHeader || src.Type == bridgev2.LoginCookieTypeRequestBody {
				return true
			}
		}
	}
	return false
}

func (c *collector) wantsBody(requestURL string) bool {
	for _, f := range c.fields {
		for _, src := range f.Sources {
			if src.Type == bridgev2.LoginCookieTypeRequestBody && c.urlMatches(src, requestURL) {
				return true
			}
		}
	}
	return false
}

func (c *collector) urlMatches(src bridgev2.LoginCookieFieldSource, requestURL string) bool {
	if src.RequestURLRegex == "" {
		return true
	}
	re := c.urls[src.RequestURLRegex]
	return re != nil && re.MatchString(requestURL)
}

// request records the header and body sources a request the page made provides. headers
// are what was actually sent, cookies included; body is "" when there was none.
func (c *collector) request(requestURL string, headers map[string]string, body string) {
	// A connector's URL patterns may be unanchored (LinkedIn's is "https://www.linkedin.com"),
	// so a request elsewhere that merely mentions the site could match: only the step's own
	// site counts.
	if c.site == "" || siteOf(requestURL) != c.site {
		return
	}
	lower := make(map[string]string, len(headers))
	for name, value := range headers {
		lower[strings.ToLower(name)] = value
	}
	var form map[string]string
	for _, f := range c.fields {
		for _, src := range f.Sources {
			if !c.urlMatches(src, requestURL) {
				continue
			}
			switch src.Type {
			case bridgev2.LoginCookieTypeRequestHeader:
				if value := lower[strings.ToLower(src.Name)]; value != "" {
					c.seen[sourceKey(src)] = value
				}
			case bridgev2.LoginCookieTypeRequestBody:
				if body == "" {
					continue
				}
				if form == nil {
					form = parseBody(lower["content-type"], body)
				}
				if value := form[src.Name]; value != "" {
					c.seen[sourceKey(src)] = value
				}
			}
		}
	}
}

// parseBody reads a request body's top-level fields, as JSON or as a form.
func parseBody(contentType, body string) map[string]string {
	fields := map[string]string{}
	mediaType, params, _ := mime.ParseMediaType(contentType)
	switch {
	case strings.HasPrefix(mediaType, "multipart/"):
		reader := multipart.NewReader(strings.NewReader(body), params["boundary"])
		for {
			part, err := reader.NextPart()
			if err != nil {
				break
			}
			if name := part.FormName(); name != "" {
				fields[name] = readAll(part)
			}
			part.Close()
		}
	case strings.TrimSpace(body) != "" && strings.TrimSpace(body)[0] == '{':
		var object map[string]any
		if json.Unmarshal([]byte(body), &object) == nil {
			for name, value := range object {
				if text, ok := stringValue(value); ok {
					fields[name] = text
				}
			}
		}
	default:
		if values, err := url.ParseQuery(body); err == nil {
			for name := range values {
				fields[name] = values.Get(name)
			}
		}
	}
	return fields
}

func readAll(part *multipart.Part) string {
	var b strings.Builder
	buf := make([]byte, 4096)
	for b.Len() < maxValue {
		n, err := part.Read(buf)
		b.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return b.String()
}

// maxValue is the longest value kept for a field: X's browser tokens are a few KiB.
const maxValue = 64 << 10

func stringValue(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		return v, v != ""
	case float64, bool:
		return fmt.Sprint(v), true
	default:
		return "", false
	}
}

// extract records what the step's script resolved: an object keyed by field ID.
func (c *collector) extract(result map[string]any) {
	for id, value := range result {
		if text, ok := stringValue(value); ok {
			c.extracted[id] = text
		}
	}
}

// collect returns every field's value found so far, from the cookies and localStorage the
// browser has now and what was recorded before, and whether it is enough to submit: every
// required field has a value, and the page is where the step says to wait for.
func (c *collector) collect(cookies []cookie, local map[string]string, pageURL string) (map[string]string, bool) {
	values := map[string]string{}
	var complete bool
	if c.waitFor != nil {
		complete = c.waitFor.MatchString(pageURL)
	} else {
		complete = c.site != "" && siteOf(pageURL) == c.site
	}
	for _, f := range c.fields {
		value := c.value(f, cookies, local)
		if value != "" {
			values[f.ID] = value
		} else if f.Required {
			complete = false
		}
	}
	return values, complete
}

func (c *collector) value(f bridgev2.LoginCookieField, cookies []cookie, local map[string]string) string {
	ok := func(value string) bool {
		if value == "" || len(value) > maxValue {
			return false
		}
		re := c.patterns[f.ID]
		return re == nil || re.MatchString(value)
	}
	// What the script resolved stands for the fields it names, whatever their sources: the
	// script is how a client gets what it can't read itself.
	if value := c.extracted[f.ID]; ok(value) {
		return value
	}
	for _, src := range f.Sources {
		var value string
		switch src.Type {
		case bridgev2.LoginCookieTypeCookie:
			domain := src.CookieDomain
			if domain == "" {
				domain = c.site
			}
			// As a browser keeps them, percent-encoded; the connector wants them decoded, and
			// the pattern is written for what it gets.
			value = decodeCookie(findCookie(cookies, src.Name, domain))
		case bridgev2.LoginCookieTypeLocalStorage:
			value = local[src.Name]
		case bridgev2.LoginCookieTypeRequestHeader, bridgev2.LoginCookieTypeRequestBody:
			value = c.seen[sourceKey(src)]
		}
		if ok(value) {
			return value
		}
	}
	return ""
}

// siteOf is a URL's registrable domain, or "" for one that has none (an address, a bad URL).
func siteOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" && u.Scheme != "http" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	// An address or a single-label name (a test's, a dev server's) is its own site.
	if _, err := netip.ParseAddr(host); err == nil || !strings.Contains(host, ".") {
		return host
	}
	site, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		return ""
	}
	return site
}

// decodeCookie percent-decodes a cookie's value, as connectors expect and as a pasted one is
// (connector.decodeCookies); one that isn't valid percent-encoding is left as it is.
func decodeCookie(value string) string {
	if decoded, err := url.PathUnescape(value); err == nil {
		return decoded
	}
	return value
}

// findCookie finds the cookie called name on domain or one of its subdomains, preferring one
// set for the domain itself.
func findCookie(cookies []cookie, name, domain string) string {
	domain = strings.ToLower(strings.TrimPrefix(domain, "."))
	found := ""
	for _, ck := range cookies {
		if ck.Name != name {
			continue
		}
		have := strings.ToLower(strings.TrimPrefix(ck.Domain, "."))
		if domain == "" {
			return ""
		} else if have == domain {
			return ck.Value
		} else if found == "" && strings.HasSuffix(have, "."+domain) {
			found = ck.Value
		}
	}
	return found
}

// wipe drops every value the collector holds.
func (c *collector) wipe() {
	clear(c.seen)
	clear(c.extracted)
}
