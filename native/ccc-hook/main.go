package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

type config struct {
	Pipe        string `json:"pipe"`
	Token       string `json:"token"`
	IdentityKey string `json:"identityKey"`
}

const adapterVersion = "1.2"
const protocolVersion = 1

type buildInfo struct {
	Kind            string `json:"kind"`
	SchemaVersion   int    `json:"schemaVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
	AdapterVersion  string `json:"adapterVersion"`
	SessionIdentity string `json:"sessionIdentity"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
}

func helperBuildInfo() buildInfo {
	return buildInfo{"ccc-hook", 1, protocolVersion, adapterVersion, "hmac-sha256-128", runtime.GOOS, runtime.GOARCH}
}

type event struct {
	ProtocolVersion int    `json:"protocolVersion"`
	EventID         string `json:"eventId"`
	Provider        string `json:"provider"`
	AdapterVersion  string `json:"adapterVersion"`
	SessionKey      string `json:"sessionKey"`
	TurnID          string `json:"turnId,omitempty"`
	Kind            string `json:"kind"`
}
type envelope struct {
	Token string `json:"token"`
	Event event  `json:"event"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,128}$`)

func validEvent(e event) bool {
	return e.ProtocolVersion == protocolVersion && (e.Provider == "claude" || e.Provider == "codex") && identifier.MatchString(e.EventID) && identifier.MatchString(e.SessionKey) && identifier.MatchString(e.AdapterVersion) && (e.TurnID == "" || identifier.MatchString(e.TurnID)) && validKind(e.Kind)
}
func validKind(k string) bool {
	switch k {
	case "start", "activity", "attention", "stop", "interrupted", "failed", "session-ended":
		return true
	}
	return false
}
func defaultConfig() string {
	h, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), "Claude Country Club", "connection.json")
	case "darwin":
		return filepath.Join(h, "Library", "Application Support", "Claude Country Club", "connection.json")
	default:
		return filepath.Join(h, ".config", "Claude Country Club", "connection.json")
	}
}
func loadConfig(p string) (config, error) {
	var c config
	if !filepath.IsAbs(p) || safePath(p) != nil {
		return c, fmt.Errorf("connection path must be absolute and regular")
	}
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return c, fmt.Errorf("invalid connection file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return c, fmt.Errorf("connection file permissions")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	key, keyErr := hex.DecodeString(c.IdentityKey)
	if len(c.Token) < 32 || len(c.Token) > 256 || c.Pipe == "" || keyErr != nil || len(key) != 32 {
		return c, fmt.Errorf("invalid connection")
	}
	return c, err
}
func normalize(provider, kind, identityKey string, r io.Reader) (event, error) {
	var e event
	key, err := hex.DecodeString(identityKey)
	if err != nil || len(key) != 32 {
		return e, fmt.Errorf("identity key")
	}
	if (provider != "claude" && provider != "codex") || !validKind(kind) {
		return e, fmt.Errorf("invalid args")
	}
	b, err := io.ReadAll(io.LimitReader(r, 262145))
	if err != nil || len(b) > 262144 {
		return e, fmt.Errorf("input bound")
	}
	// Decode only the identity fields. Prompt, tool and transcript fields never leave this process.
	var p struct {
		SessionID  string `json:"session_id"`
		Cwd        string `json:"cwd"`
		TurnID     string `json:"turn_id"`
		AgentID    string `json:"agent_id"`
		AgentType  string `json:"agent_type"`
		ParentID   string `json:"parent_session_id"`
		IsSubagent bool   `json:"is_subagent"`
		ToolName   string `json:"tool_name"`
	}
	if json.Unmarshal(b, &p) != nil || p.SessionID == "" || len(p.SessionID) > 4096 || len(p.Cwd) > 16384 || p.AgentID != "" || p.ParentID != "" || p.IsSubagent || (p.AgentType != "" && p.AgentType != "main") {
		return e, fmt.Errorf("unusable root identity")
	}
	// These documented Claude tools require a user answer. Classify the existing
	// PreToolUse signal without inspecting tool_input, questions or plan contents.
	if provider == "claude" && kind == "activity" && (p.ToolName == "AskUserQuestion" || p.ToolName == "ExitPlanMode") {
		kind = "attention"
	}
	hash := hmac.New(sha256.New, key)
	_, _ = hash.Write([]byte(provider + "\x00" + p.SessionID + "\x00" + p.Cwd))
	id := make([]byte, 16)
	if _, err = rand.Read(id); err != nil {
		return e, err
	}
	e = event{protocolVersion, hex.EncodeToString(id), provider, adapterVersion, hex.EncodeToString(hash.Sum(nil)[:16]), "", kind}
	if identifier.MatchString(p.TurnID) {
		e.TurnID = p.TurnID
	}
	return e, nil
}
func frame(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil || len(b) > 16384 {
		return fmt.Errorf("frame bound")
	}
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(b)))
	if _, err = w.Write(n[:]); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}
func readFrame(r io.Reader, v any) error {
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return err
	}
	size := binary.BigEndian.Uint32(n[:])
	if size == 0 || size > 16384 {
		return fmt.Errorf("frame bound")
	}
	b := make([]byte, size)
	if _, err := io.ReadFull(r, b); err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}
func helper(p, provider, kind string) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := loadConfig(p)
		if err != nil {
			return
		}
		e, err := normalize(provider, kind, c.IdentityKey, os.Stdin)
		if err != nil {
			return
		}
		conn, err := dial(c.Pipe, 150*time.Millisecond)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(100 * time.Millisecond))
		_ = frame(conn, envelope{c.Token, e})
	}()
	select {
	case <-done:
	case <-time.After(240 * time.Millisecond):
	}
}
func serve(p string) error {
	c, err := loadConfig(p)
	if err != nil {
		return err
	}
	listener, err := listen(c.Pipe)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer cleanup(c.Pipe)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	defer signal.Stop(stop)
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); listener.Close() }()
	go func() { <-stop; listener.Close() }()
	out := json.NewEncoder(os.Stdout)
	if err = out.Encode(map[string]bool{"ready": true}); err != nil {
		return err
	}
	sem := make(chan struct{}, 16)
	var mu sync.Mutex
	for {
		conn, err := listener.Accept()
		if err != nil {
			return nil
		}
		select {
		case sem <- struct{}{}:
			go func(conn net.Conn) {
				defer func() { <-sem }()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(200 * time.Millisecond))
				var v envelope
				if readFrame(conn, &v) != nil || subtle.ConstantTimeCompare([]byte(v.Token), []byte(c.Token)) != 1 || !validEvent(v.Event) {
					return
				}
				mu.Lock()
				defer mu.Unlock()
				_ = out.Encode(map[string]event{"event": v.Event})
			}(conn)
		default:
			conn.Close()
		}
	}
}

// Cleanup uses only the current user's known provider files, never ledger-supplied paths.
func safePath(p string) error {
	for {
		info, err := os.Lstat(p)
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink")
		}
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		parent := filepath.Dir(p)
		if parent == p {
			return nil
		}
		p = parent
	}
}
func replaceFile(p string, b, expected []byte) error {
	if err := safePath(p); err != nil {
		return err
	}
	info, err := os.Stat(p)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(p), ".ccc-cleanup-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(info.Mode().Perm()); err == nil {
		_, err = f.Write(b)
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	current, err := os.ReadFile(p)
	if err != nil || !bytes.Equal(current, expected) {
		return fmt.Errorf("configuration changed during cleanup")
	}
	return os.Rename(name, p)
}
func removeIntegrations(dataDir string) error {
	if !filepath.IsAbs(dataDir) {
		return fmt.Errorf("cleanup directory must be absolute")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	return removeIntegrationsAt(dataDir, home)
}
func commandStrings(value any, includeArgs bool) []string {
	var result []string
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			result = append(result, commandStrings(item, includeArgs)...)
		}
	case map[string]any:
		for key, item := range v {
			if key == "command" {
				if cmd, ok := item.(string); ok && cmd != "" {
					result = append(result, cmd)
				}
			} else if key == "args" && includeArgs {
				if args, ok := item.([]any); ok {
					for _, arg := range args {
						if text, ok := arg.(string); ok {
							result = append(result, text)
						}
					}
				}
			} else {
				result = append(result, commandStrings(item, includeArgs)...)
			}
		}
	}
	return result
}
func removeIntegrationsAt(dataDir, home string) error {
	ledgerPath := filepath.Join(dataDir, "config-patches.json")
	if err := safePath(ledgerPath); err != nil {
		return err
	}
	b, err := os.ReadFile(ledgerPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || len(b) > 1048576 {
		return fmt.Errorf("invalid ledger")
	}
	var ledger map[string]struct {
		ConfigPath string `json:"configPath"`
		Entries    []struct {
			Event string `json:"event"`
			Group any    `json:"group"`
		} `json:"entries"`
	}
	if json.Unmarshal(b, &ledger) != nil || ledger == nil {
		return fmt.Errorf("invalid ledger")
	}
	for provider, patch := range ledger {
		var file string
		switch provider {
		case "claude":
			file = filepath.Join(home, ".claude", "settings.json")
		case "codex":
			file = filepath.Join(home, ".codex", "hooks.json")
		default:
			return fmt.Errorf("invalid provider")
		}
		if filepath.Clean(patch.ConfigPath) != filepath.Clean(file) {
			return fmt.Errorf("ownership path mismatch")
		}
		if err = safePath(file); err != nil {
			return err
		}
		text, readErr := os.ReadFile(file)
		if os.IsNotExist(readErr) {
			delete(ledger, provider)
			continue
		}
		if readErr != nil || len(text) > 1048576 {
			return fmt.Errorf("invalid provider configuration")
		}
		var obj map[string]any
		if json.Unmarshal(text, &obj) != nil {
			return fmt.Errorf("malformed provider configuration")
		}
		hooks, _ := obj["hooks"].(map[string]any)
		var prefixes []string
		for _, entry := range patch.Entries {
			for _, cmd := range commandStrings(entry.Group, false) {
				prefixes = append(prefixes, strings.SplitN(cmd, " --provider ", 2)[0])
			}
			list, ok := hooks[entry.Event].([]any)
			if !ok {
				continue
			}
			kept := make([]any, 0, len(list))
			for _, v := range list {
				if !reflect.DeepEqual(v, entry.Group) {
					kept = append(kept, v)
				}
			}
			if len(kept) == 0 {
				delete(hooks, entry.Event)
			} else {
				hooks[entry.Event] = kept
			}
		}
		for _, cmd := range commandStrings(hooks, true) {
			for _, prefix := range prefixes {
				if strings.Contains(cmd, prefix) {
					return fmt.Errorf("modified owned hooks remain; preserve helper and ownership")
				}
			}
		}
		out, _ := json.MarshalIndent(obj, "", "  ")
		if err = replaceFile(file, append(out, '\n'), text); err != nil {
			return err
		}
		delete(ledger, provider)
	}
	out, _ := json.MarshalIndent(ledger, "", "  ")
	return replaceFile(ledgerPath, append(out, '\n'), b)
}
func main() {
	// Packaging-only introspection: no home/config lookup, stdin read or IPC.
	// Normal hook invocations retain the silent fail-open behavior.
	if len(os.Args) == 2 && os.Args[1] == "--build-info" {
		_ = json.NewEncoder(os.Stdout).Encode(helperBuildInfo())
		return
	}
	fs := flag.NewFlagSet("ccc-hook", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	p := fs.String("config", defaultConfig(), "")
	provider := fs.String("provider", "", "")
	kind := fs.String("event", "", "")
	server := fs.Bool("serve", false, "")
	clean := fs.Bool("cleanup", false, "")
	dataDir := fs.String("data-dir", filepath.Dir(defaultConfig()), "")
	if fs.Parse(os.Args[1:]) != nil {
		return
	}
	if *clean {
		if removeIntegrations(*dataDir) != nil {
			os.Exit(2)
		}
	} else if *server {
		_ = serve(*p)
	} else {
		helper(*p, *provider, *kind)
	}
}
