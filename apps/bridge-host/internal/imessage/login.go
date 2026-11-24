package imessage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/rs/zerolog"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/imessage/bluebubbles"
)

// FlowBlueBubbles is the one login flow: a BlueBubbles Server's address and password.
const FlowBlueBubbles = "bluebubbles"

func (c *Connector) GetLoginFlows() []bridgev2.LoginFlow {
	return []bridgev2.LoginFlow{{
		Name:        "BlueBubbles Server",
		Description: "Connect the BlueBubbles Server running on your Mac",
		ID:          FlowBlueBubbles,
	}}
}

func (c *Connector) CreateLogin(ctx context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	if flowID != FlowBlueBubbles {
		return nil, bridgev2.ErrInvalidLoginFlowID
	}
	return &login{user: user, allow: c.allow}, nil
}

type login struct {
	user  *bridgev2.User
	allow bluebubbles.AddressPolicy
}

var _ bridgev2.LoginProcessUserInput = (*login)(nil)

func (l *login) Cancel() {}

func (l *login) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	return &bridgev2.LoginStep{
		Type:   bridgev2.LoginStepTypeUserInput,
		StepID: "imessage.bluebubbles.server",
		Instructions: "Enter the server address and password BlueBubbles Server shows on your Mac. " +
			"The Mac must stay on, signed in to Messages, and reachable from this server.",
		UserInputParams: &bridgev2.LoginUserInputParams{
			Fields: []bridgev2.LoginInputDataField{{
				Type:        bridgev2.LoginInputFieldTypeURL,
				ID:          "url",
				Name:        "Server address",
				Description: "For example http://192.168.1.20:1234, or your BlueBubbles proxy's https address",
			}, {
				Type:        bridgev2.LoginInputFieldTypePassword,
				ID:          "password",
				Name:        "Server password",
				Description: "The password set in BlueBubbles Server's settings",
			}},
		},
	}, nil
}

// loginCheckTimeout bounds asking the server about itself while signing in.
const loginCheckTimeout = 30 * time.Second

func (l *login) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	bb, err := bluebubbles.New(input["url"], input["password"], l.allow)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errBadAddress, err)
	}
	checkCtx, cancel := context.WithTimeout(ctx, loginCheckTimeout)
	defer cancel()
	info, err := bb.ServerInfo(checkCtx)
	if err != nil {
		return nil, err
	}
	if info.ComputerID == "" {
		return nil, errNoComputerID
	}
	ul, err := l.user.NewLogin(ctx, &database.UserLogin{
		ID: loginID(info.ComputerID),
		// The Apple ID is the person's own; it is only shown to them, as their account's name.
		RemoteName: info.DetectedIMessage,
		Metadata:   &LoginMetadata{ServerURL: bb.ServerURL(), Password: input["password"]},
	}, &bridgev2.NewLoginParams{DeleteOnConflict: true})
	if err != nil {
		return nil, fmt.Errorf("failed to save the login: %w", err)
	}
	ul.Client.Connect(ul.Log.WithContext(context.WithoutCancel(ctx)))
	return &bridgev2.LoginStep{
		Type:   bridgev2.LoginStepTypeComplete,
		StepID: "imessage.bluebubbles.complete",
		CompleteParams: &bridgev2.LoginCompleteParams{
			UserLoginID: ul.ID,
			UserLogin:   ul,
		},
	}, nil
}

var (
	errBadAddress   = errors.New("imessage: the server address isn't one")
	errNoComputerID = errors.New("imessage: the server didn't say which Mac it is")
)

// DescribeLoginError says, for the log, why a login failed: the bridge host shows the person
// only a code, and logs no error's text, which could quote what they typed.
func (c *Connector) DescribeLoginError(evt *zerolog.Event, err error) {
	var bbErr *bluebubbles.Error
	reason := "unreachable"
	switch {
	case errors.Is(err, errBadAddress):
		reason = "bad_address"
	case errors.Is(err, errNoComputerID):
		reason = "old_server"
	case errors.Is(err, bluebubbles.ErrAddressRefused):
		reason = "address_refused"
	case errors.As(err, &bbErr) && bbErr.Unauthorized():
		reason = "wrong_password"
	case errors.As(err, &bbErr) && bbErr.Status == 429:
		reason = "throttled"
	case errors.As(err, &bbErr):
		reason = "not_bluebubbles"
		evt.Int("imessage_status", bbErr.Status)
	}
	evt.Str("imessage_reason", reason)
}
