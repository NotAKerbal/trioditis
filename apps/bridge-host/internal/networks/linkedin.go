package networks

import (
	"fmt"

	linkedin "go.mau.fi/mautrix-linkedin/pkg/connector"
	"maunium.net/go/mautrix/bridgev2"
)

// linkedinDisplayname is the connector's own template without its " (LinkedIn)" suffix: the
// app shows each contact with its network's badge, so the suffix would only be noise.
const linkedinDisplayname = "{{ with .Organization }}{{ . }}{{ else }}{{ .FirstName }} {{ .LastName }}{{ end }}"

func init() {
	register("linkedin", Network{
		New: func() (bridgev2.NetworkConnector, error) {
			conn := &linkedin.LinkedInConnector{}
			if _, err := withDefaults("LinkedIn", conn); err != nil {
				return nil, err
			}
			conn.Config.DisplaynameTemplate = linkedinDisplayname
			if err := conn.Config.PostProcess(); err != nil {
				return nil, fmt.Errorf("failed to set the LinkedIn displayname template: %w", err)
			}
			// Login responses are never logged, even redacted: they carry session cookies.
			conn.Config.LogRedactedLoginResponses = false
			return conn, nil
		},
	})
}
