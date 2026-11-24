package networks

import (
	"fmt"
	"sync"

	igconnector "go.mau.fi/mautrix-meta/pkg/igconnector"
	"go.mau.fi/mautrix-meta/pkg/messagix/graphql"
	"maunium.net/go/mautrix/bridgev2"
)

// Instagram, from mautrix-meta's igconnector. Unlike Messenger it doesn't use whatsmeow, so
// there is no decrypted-event buffer to sweep; see docs/networks/instagram.md.
func init() {
	register("instagram", Network{
		ProxyEnv: "INSTAGRAM_PROXY",
		New: func() (bridgev2.NetworkConnector, error) {
			if err := instagramWritesOnce(); err != nil {
				return nil, err
			}
			conn := &igconnector.IGConnector{}
			if _, err := withDefaults("Instagram", conn); err != nil {
				return nil, err
			}
			proxy, err := metaProxy("INSTAGRAM_PROXY")
			if err != nil {
				return nil, err
			}
			conn.Config.Proxy = proxy
			return conn, nil
		},
	})
}

// instagramWrites are messagix's GraphQL mutations that send, edit or delete a message or a
// reaction on Instagram (instameow's SendMessage, SendMedia, EditMessage, UnsendMessage and
// SendReaction).
var instagramWrites = []string{
	"IGDirectTextSendMutation",
	"IGDirectMediaSendMutation",
	"IGDirectEditMessageMutation",
	"IGDMessageUnsendDialogOffMsysMutation",
	"IGDirectReactionSendMutation",
}

var (
	instagramOnce    sync.Once
	instagramOnceErr error
)

// instagramWritesOnce marks instagramWrites NoRetry, so messagix makes each one request
// (MakeRequestOnce) instead of posting it again after a transport error or a 5xx, whose outcome
// is unknown: a message could go twice, or a repeated edit overwrite a newer one the person
// made on their phone. The connector then reports the failure, which the bridge host records
// as unknown, and nothing is repeated. Each network runs in its own process, and this runs
// before its connector exists, so nothing reads the table meanwhile.
func instagramWritesOnce() error {
	instagramOnce.Do(func() {
		for _, name := range instagramWrites {
			doc, ok := graphql.GraphQLDocs[name]
			if !ok {
				instagramOnceErr = fmt.Errorf("instagram: messagix has no %s any more", name)
				return
			}
			doc.NoRetry = true
			graphql.GraphQLDocs[name] = doc
		}
	})
	return instagramOnceErr
}
