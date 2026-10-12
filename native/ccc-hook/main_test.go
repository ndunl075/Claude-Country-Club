package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testIdentityKey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestPrivateSessionIdentity(t *testing.T) {
	payload := `{"session_id":"root","cwd":"private-project","turn_id":"turn-1"}`
	a, err := normalize("codex", "start", testIdentityKey, strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := normalize("codex", "stop", testIdentityKey, strings.NewReader(payload))
	c, _ := normalize("codex", "start", strings.Repeat("c", 64), strings.NewReader(payload))
	d, _ := normalize("claude", "start", testIdentityKey, strings.NewReader(payload))
	if a.SessionKey != b.SessionKey || a.SessionKey == c.SessionKey || a.SessionKey == d.SessionKey {
		t.Fatal("identity key/provider separation")
	}
	for _, key := range []string{"", "invalid", strings.Repeat("a", 62)} {
		if _, err := normalize("codex", "start", key, strings.NewReader(payload)); err == nil {
			t.Fatal("accepted invalid key")
		}
	}
	data, _ := json.Marshal(a)
	if strings.Contains(string(data), testIdentityKey) || strings.Contains(string(data), "private-project") || strings.Contains(string(data), `"root"`) {
		t.Fatal("identity material leaked")
	}
}

func testDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestNormalizePrivacy(t *testing.T) {
	e, err := normalize("claude", "start", testIdentityKey, strings.NewReader(`{"session_id":"s","cwd":"C:/secret/project","prompt":"private","transcript_path":"secret","turn_id":"turn-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	frame(&b, envelope{Token: "test", Event: e})
	if strings.Contains(b.String(), "secret") || strings.Contains(b.String(), "private") {
		t.Fatal("sensitive data leaked")
	}
	if e.TurnID != "turn-1" || !validEvent(e) {
		t.Fatal("schema")
	}
}
func TestRejectInput(t *testing.T) {
	for _, s := range []string{`{`, `{}`, `{"session_id":"s","agent_id":"child"}`, `{"session_id":"s","is_subagent":true}`, strings.Repeat("x", 262145)} {
		if _, err := normalize("codex", "start", testIdentityKey, strings.NewReader(s)); err == nil {
			t.Fatal("accepted invalid input")
		}
	}
}
func TestUserInteractionToolAttention(t *testing.T) {
	for _, tool := range []string{"AskUserQuestion", "ExitPlanMode", "Bash", "mcp__other__AskUserQuestion"} {
		for _, provider := range []string{"claude", "codex"} {
			payload := fmt.Sprintf(`{"session_id":"root","cwd":"private-project","tool_name":%q,"tool_input":{"questions":["private-question"],"plan":"private-plan"}}`, tool)
			e, err := normalize(provider, "activity", testIdentityKey, strings.NewReader(payload))
			if err != nil {
				t.Fatal(err)
			}
			want := "activity"
			if provider == "claude" && (tool == "AskUserQuestion" || tool == "ExitPlanMode") {
				want = "attention"
			}
			if e.Kind != want {
				t.Fatalf("%s/%s: got %s, want %s", provider, tool, e.Kind, want)
			}
			data, _ := json.Marshal(e)
			if strings.Contains(string(data), "private") || strings.Contains(string(data), tool) {
				t.Fatal("tool content or name leaked")
			}
		}
	}
	if _, err := normalize("claude", "activity", testIdentityKey, strings.NewReader(`{"session_id":"root","agent_id":"child","tool_name":"AskUserQuestion"}`)); err == nil {
		t.Fatal("child question accepted")
	}
}
func TestPassiveClaudeErrorAndElicitationPrivacy(t *testing.T) {
	for _, kind := range []string{"attention", "failed"} {
		payload := `{"session_id":"root","cwd":"private-project","error":"rate_limit","error_details":"PRIVATE-ERROR","last_assistant_message":"PRIVATE-RESPONSE","mcp_server_name":"PRIVATE-SERVER","message":"PRIVATE-FORM","url":"https://PRIVATE-LOGIN.invalid","requested_schema":{"private":"PRIVATE-SCHEMA"}}`
		e, err := normalize("claude", kind, testIdentityKey, strings.NewReader(payload))
		if err != nil || e.Kind != kind {
			t.Fatalf("passive %s: %v", kind, err)
		}
		data, _ := json.Marshal(e)
		if strings.Contains(string(data), "PRIVATE") || strings.Contains(string(data), "private-project") || strings.Contains(string(data), "rate_limit") {
			t.Fatal("private failure or elicitation content leaked")
		}
		if _, err := normalize("claude", kind, testIdentityKey, strings.NewReader(`{"session_id":"root","agent_id":"child"}`)); err == nil {
			t.Fatal("child input affected root lifecycle")
		}
	}
}
func TestFrameBounds(t *testing.T) {
	var b bytes.Buffer
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], 16385)
	b.Write(n[:])
	var e envelope
	if readFrame(&b, &e) == nil {
		t.Fatal("accepted oversized frame")
	}
}
func TestHelperSubprocess(t *testing.T) {
	if os.Getenv("CCC_HELPER_CHILD") != "1" {
		return
	}
	for i, a := range os.Args {
		if a == "--" {
			os.Args = append([]string{os.Args[0]}, os.Args[i+1:]...)
			main()
			os.Exit(0)
		}
	}
	os.Exit(0)
}
func child(args ...string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], append([]string{"-test.run=^TestHelperSubprocess$", "--"}, args...)...)
	cmd.Env = append(os.Environ(), "CCC_HELPER_CHILD=1")
	return cmd
}
func TestSilentFailOpen(t *testing.T) {
	dir := testDir(t)
	conf := filepath.Join(dir, "connection.json")
	b, _ := json.Marshal(config{`\\.\pipe\country-club-absent-test`, strings.Repeat("a", 64), testIdentityKey})
	if err := os.WriteFile(conf, b, 0600); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{`{`, strings.Repeat("x", 262145), `{"session_id":"s"}`} {
		cmd := child("--provider", "claude", "--event", "start", "--config", conf)
		cmd.Stdin = strings.NewReader(input)
		out, err := cmd.CombinedOutput()
		if err != nil || len(out) != 0 {
			t.Fatalf("helper output or failed exit %q %v", out, err)
		}
	}
	cmd := child("--provider", "claude", "--event", "start", "--config", conf)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	started := time.Now()
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if err = cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	stdin.Close()
	if time.Since(started) > time.Second || out.Len() != 0 {
		t.Fatal("blocked stdin was not bounded and silent")
	}
}
func TestBrokerAuth(t *testing.T) {
	dir := testDir(t)
	os.Chmod(dir, 0700)
	pipe := filepath.Join(dir, "events.sock")
	if runtime.GOOS == "windows" {
		pipe = fmt.Sprintf(`\\.\pipe\country-club-test-%d`, time.Now().UnixNano())
	}
	c := config{pipe, strings.Repeat("a", 64), testIdentityKey}
	b, _ := json.Marshal(c)
	conf := filepath.Join(dir, "connection.json")
	os.WriteFile(conf, b, 0600)
	if _, err := loadConfig(conf); err != nil {
		t.Fatal(err)
	}
	l, err := listen(pipe)
	if err != nil {
		t.Fatal(err)
	}
	l.Close()
	cleanup(pipe)
	cmd := child("--serve", "--config", conf)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	reader := bufio.NewReader(stdout)
	line, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(line, `"ready":true`) {
		t.Fatalf("not ready %q %v %s", line, err, stderr.String())
	}
	e, _ := normalize("claude", "start", testIdentityKey, strings.NewReader(`{"session_id":"s"}`))
	bad := e
	bad.Kind = "attention"
	conn, err := dial(pipe, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	frame(conn, envelope{strings.Repeat("b", 64), bad})
	conn.Close()
	time.Sleep(20 * time.Millisecond)
	conn, err = dial(pipe, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	frame(conn, envelope{c.Token, e})
	conn.Close()
	line, err = reader.ReadString('\n')
	if err != nil || !strings.Contains(line, `"kind":"start"`) || strings.Contains(line, `"token"`) {
		t.Fatalf("authentication failed %q %v", line, err)
	}
	stdin.Close()
	if err = cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if stderr.Len() != 0 {
		t.Fatal("unexpected stderr")
	}
}
func TestCleanupStructural(t *testing.T) {
	dir := testDir(t)
	home := filepath.Join(dir, "home")
	data := filepath.Join(dir, "data")
	file := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(file), 0700)
	os.MkdirAll(data, 0700)
	group := map[string]any{"hooks": []any{map[string]any{"command": "ccc-owned", "type": "command"}}}
	obj := map[string]any{"theme": "keep", "hooks": map[string]any{"Stop": []any{group, map[string]any{"user": "keep"}}}}
	b, _ := json.Marshal(obj)
	os.WriteFile(file, b, 0600)
	ledger := map[string]any{"claude": map[string]any{"configPath": file, "entries": []any{map[string]any{"event": "Stop", "group": group}}}}
	b, _ = json.Marshal(ledger)
	os.WriteFile(filepath.Join(data, "config-patches.json"), b, 0600)
	if err := removeIntegrationsAt(data, home); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(file)
	if strings.Contains(string(b), "ccc-owned") || !strings.Contains(string(b), "keep") {
		t.Fatalf("incorrect inverse %s", b)
	}
}

func TestCleanupExecArguments(t *testing.T) {
	for _, mode := range []string{"unchanged", "edited-args", "wrapped"} {
		t.Run(mode, func(t *testing.T) {
			edited := mode != "unchanged"
			dir := testDir(t)
			home, data := filepath.Join(dir, "home"), filepath.Join(dir, "data")
			file := filepath.Join(home, ".claude", "settings.json")
			os.MkdirAll(filepath.Dir(file), 0700)
			os.MkdirAll(data, 0700)
			group := map[string]any{"hooks": []any{map[string]any{"command": "ccc-owned.exe", "args": []any{"--provider", "claude", "--event", "stop"}, "type": "command"}}}
			installed := map[string]any{"hooks": []any{map[string]any{"command": "ccc-owned.exe", "args": []any{"--provider", "claude", "--event", "stop"}, "type": "command"}}}
			if edited {
				installed["hooks"].([]any)[0].(map[string]any)["args"] = []any{"user-edit"}
			}
			if mode == "wrapped" {
				hook := installed["hooks"].([]any)[0].(map[string]any)
				hook["command"] = "wrapper.exe"
				hook["args"] = []any{"ccc-owned.exe", "--provider", "claude"}
			}
			config, _ := json.Marshal(map[string]any{"theme": "keep", "hooks": map[string]any{"Stop": []any{installed}}})
			ledger, _ := json.Marshal(map[string]any{"claude": map[string]any{"configPath": file, "entries": []any{map[string]any{"event": "Stop", "group": group}}}})
			ledgerFile := filepath.Join(data, "config-patches.json")
			os.WriteFile(file, config, 0600)
			os.WriteFile(ledgerFile, ledger, 0600)
			err := removeIntegrationsAt(data, home)
			after, _ := os.ReadFile(file)
			if edited {
				ownership, _ := os.ReadFile(ledgerFile)
				if err == nil || !bytes.Equal(after, config) || !bytes.Equal(ownership, ledger) {
					t.Fatal("edited exec arguments or ownership were lost")
				}
			} else if err != nil || strings.Contains(string(after), "ccc-owned") || !strings.Contains(string(after), "keep") {
				t.Fatalf("exec inverse failed: %v", err)
			}
		})
	}
}

func TestCleanupModifiedGroupPreservesOwnership(t *testing.T) {
	dir := testDir(t)
	home := filepath.Join(dir, "home")
	data := filepath.Join(dir, "data")
	file := filepath.Join(home, ".codex", "hooks.json")
	os.MkdirAll(filepath.Dir(file), 0700)
	os.MkdirAll(data, 0700)
	original := map[string]any{"hooks": []any{map[string]any{"command": "'ccc-hook' --provider codex --event stop", "type": "command", "timeout": float64(1)}}}
	modified := map[string]any{"hooks": []any{map[string]any{"command": "'ccc-hook' --provider codex --event stop", "type": "command", "timeout": float64(2)}}}
	obj := map[string]any{"hooks": map[string]any{"Stop": []any{modified}}}
	configBytes, _ := json.Marshal(obj)
	os.WriteFile(file, configBytes, 0600)
	ledger := map[string]any{"codex": map[string]any{"configPath": file, "entries": []any{map[string]any{"event": "Stop", "group": original}}}}
	ledgerBytes, _ := json.Marshal(ledger)
	ledgerPath := filepath.Join(data, "config-patches.json")
	os.WriteFile(ledgerPath, ledgerBytes, 0600)
	if err := removeIntegrationsAt(data, home); err == nil {
		t.Fatal("modified helper reference should block uninstall")
	}
	after, _ := os.ReadFile(file)
	if !bytes.Equal(after, configBytes) {
		t.Fatal("modified user hooks overwritten")
	}
	after, _ = os.ReadFile(ledgerPath)
	if !bytes.Equal(after, ledgerBytes) {
		t.Fatal("ownership lost")
	}
}
