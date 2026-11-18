package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestMain lets a test run this binary's main in a child process: the test binary re-runs
// itself with TRIODITIS_TEST_RUN_MAIN set and the command's arguments.
func TestMain(m *testing.M) {
	if os.Getenv("TRIODITIS_TEST_RUN_MAIN") == "1" {
		os.Args = append([]string{"bridge-host"}, strings.Fields(os.Getenv("TRIODITIS_TEST_ARGS"))...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// A prompt gives up when its context ends, even with its input still open and silent.
func TestPromptReturnsWhenCancelledWithInputOpen(t *testing.T) {
	r, w := io.Pipe()
	defer w.Close()
	lines := newLineReader(r)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := lines.next(ctx)
		done <- err
	}()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected cancellation, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the prompt kept waiting for input after its context ended")
	}
}

// Ctrl+C or SIGTERM at a login prompt, with stdin open, ends the process promptly, and
// through the normal shutdown: the host is stopped, and a login that didn't finish fails
// the process.
func TestLoginPromptExitsOnSignal(t *testing.T) {
	for _, sig := range []syscall.Signal{syscall.SIGINT, syscall.SIGTERM} {
		t.Run(sig.String(), func(t *testing.T) {
			stdin, held, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer stdin.Close()
			defer held.Close() // the write end stays open: stdin never reaches EOF
			var out bytes.Buffer
			cmd := exec.Command(os.Args[0])
			cmd.Env = childEnv(t)
			cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, &syncWriter{buf: &out}, &syncWriter{buf: &out}
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			// However the test ends, the child is killed and reaped.
			exited := make(chan error, 1)
			go func() { exited <- cmd.Wait() }()
			defer func() {
				_ = cmd.Process.Kill()
				<-exited
			}()
			deadline := time.Now().Add(20 * time.Second)
			for !strings.Contains(outString(&out), "Username: ") {
				if time.Now().After(deadline) {
					t.Fatalf("no prompt; output:\n%s", outString(&out))
				}
				time.Sleep(20 * time.Millisecond)
			}
			if err = cmd.Process.Signal(sig); err != nil {
				t.Fatal(err)
			}
			select {
			case err = <-exited:
				exited <- err // for the deferred reap
			case <-time.After(10 * time.Second):
				t.Fatalf("still running 10s after %s at the prompt", sig)
			}
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
				t.Fatalf("expected exit status 1, got %v", err)
			}
			if text := outString(&out); !strings.Contains(text, "Bridge host stopped") {
				t.Fatalf("the host wasn't stopped; output:\n%s", text)
			}
		})
	}
}

// childEnv is the child's whole environment: nothing from the shell that could point it at
// a real bridge database, gateway or keys, only what a process needs plus this test's own
// throwaway settings.
func childEnv(t *testing.T) []string {
	env := []string{
		"TRIODITIS_TEST_RUN_MAIN=1",
		"TRIODITIS_TEST_ARGS=--network fake --dev-keys --user isaac login",
		// The database defaults to a file in here.
		"BRIDGE_DATA_DIR=" + t.TempDir(),
		// Nothing listens here: the child can't reach a real gateway.
		"GATEWAY_URL=http://127.0.0.1:1",
		"BRIDGE_HOST_ADDR=127.0.0.1:0",
	}
	for _, name := range []string{"PATH", "HOME", "TMPDIR", "GOCOVERDIR"} {
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	return env
}

var outLock = make(chan struct{}, 1)

// syncWriter lets the child's stdout and stderr share one buffer the test reads while
// they are written.
type syncWriter struct{ buf *bytes.Buffer }

func (w *syncWriter) Write(p []byte) (int, error) {
	outLock <- struct{}{}
	defer func() { <-outLock }()
	return w.buf.Write(p)
}

func outString(buf *bytes.Buffer) string {
	outLock <- struct{}{}
	defer func() { <-outLock }()
	return buf.String()
}
