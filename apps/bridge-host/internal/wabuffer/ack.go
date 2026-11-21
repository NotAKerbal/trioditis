package wabuffer

import (
	"errors"
	"reflect"
	"sync"
	"unsafe"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/NotAKerbal/trioditis/apps/bridge-host/internal/handled"
)

// whatsmeow acknowledges an incoming message (and clears its buffered plaintext) as soon as
// every event handler returns success. WrapAck holds that back until the message is journaled
// (handled.Acker): mautrix-whatsapp's handler returns what bridgev2 says, which is success
// once bridgev2's handler limit passes, journaled or not.

// WrapAck is the handler to give whatsmeow in place of next. Only messages are held back: they
// are what WhatsApp would not send again.
func WrapAck(a *handled.Acker) func(whatsmeow.EventHandlerWithSuccessStatus) whatsmeow.EventHandlerWithSuccessStatus {
	return func(next whatsmeow.EventHandlerWithSuccessStatus) whatsmeow.EventHandlerWithSuccessStatus {
		return func(evt any) bool {
			msg, ok := evt.(*events.Message)
			if !ok {
				return next(evt)
			}
			return a.Handle(msg, func() bool { return next(evt) })
		}
	}
}

// ErrNoHandlers is a whatsmeow client whose handler list this version of the host can't find.
var ErrNoHandlers = errors.New("wabuffer: whatsmeow's event handler list isn't where it was")

// WrapHandlers replaces each of cli's event handlers with wrap's version of it. whatsmeow has
// no way to wrap a handler another package registered (mautrix-whatsapp's, here), so this
// reaches into its unexported list; a whatsmeow update that moves it fails the tests and
// returns ErrNoHandlers rather than going unwrapped silently. A client with no handlers is
// refused too: a live one always has mautrix-whatsapp's, so none means it is somewhere this
// can't see.
func WrapHandlers(cli *whatsmeow.Client, wrap func(whatsmeow.EventHandlerWithSuccessStatus) whatsmeow.EventHandlerWithSuccessStatus) error {
	if cli == nil {
		return ErrNoHandlers
	}
	v := reflect.ValueOf(cli).Elem()
	if v.Kind() != reflect.Struct {
		return ErrNoHandlers
	}
	list := v.FieldByName("eventHandlers")
	lockField := v.FieldByName("eventHandlersLock")
	if !list.IsValid() || list.Kind() != reflect.Slice || !lockField.IsValid() || lockField.Type() != reflect.TypeFor[sync.RWMutex]() {
		return ErrNoHandlers
	}
	elem := list.Type().Elem()
	if elem.Kind() != reflect.Struct {
		return ErrNoHandlers
	}
	fn, ok := elem.FieldByName("fn")
	if !ok || fn.Type != reflect.TypeFor[whatsmeow.EventHandlerWithSuccessStatus]() {
		return ErrNoHandlers
	}
	mu := (*sync.RWMutex)(unsafe.Pointer(lockField.UnsafeAddr()))
	mu.Lock()
	defer mu.Unlock()
	list = reflect.NewAt(list.Type(), unsafe.Pointer(list.UnsafeAddr())).Elem()
	if list.Len() == 0 {
		return ErrNoHandlers
	}
	for i := range list.Len() {
		field := list.Index(i).FieldByIndex(fn.Index)
		field = reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem()
		orig := field.Interface().(whatsmeow.EventHandlerWithSuccessStatus)
		field.Set(reflect.ValueOf(wrap(orig)))
	}
	return nil
}
