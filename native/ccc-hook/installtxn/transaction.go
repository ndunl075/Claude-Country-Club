// Package installtxn implements a recoverable, same-volume application swap.
// User data and provider configuration never live in the transaction tree.
package installtxn

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const AppID = "com.countryclub.desktop"
const ManifestName = "ccc-package.json"

type Manifest struct {
	AppID   string            `json:"appId"`
	Version string            `json:"version"`
	Files   map[string]string `json:"files"`
}
type Journal struct {
	Format       int             `json:"format"`
	AppID        string          `json:"appId"`
	Target       string          `json:"target"`
	Phase        string          `json:"phase"`
	Previous     bool            `json:"previous"`
	Registration json.RawMessage `json:"registration"`
}

// Registration implementations may read/write only Country Club-owned keys.
type Registration interface {
	Capture(target string) (json.RawMessage, error)
	Restore(json.RawMessage) error
}
type Transaction struct {
	Target, Directory, Stage, Backup string
	Registry                         Registration
	Rename                           func(string, string) error
	// RetryFor bounds how long a rename or tree removal is retried when
	// Windows reports a transient sharing/access error, for example while a
	// just-closed application or a virus scanner still holds a handle.
	RetryFor time.Duration
}

// DefaultRetryFor is the bounded wait applied to filesystem operations that can
// lose a race with a process that is still releasing the installed files.
const DefaultRetryFor = 20 * time.Second

// Logf records installer diagnostics. The coordinator binary replaces it with a
// bounded file logger; library users and tests get a no-op.
var Logf = func(format string, args ...any) {}

func (t *Transaction) retry(what string, fn func() error) error {
	deadline := time.Now().Add(t.RetryFor)
	for attempt := 1; ; attempt++ {
		err := fn()
		if err == nil {
			if attempt > 1 {
				Logf("%s succeeded on attempt %d", what, attempt)
			}
			return nil
		}
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrExist) || !time.Now().Before(deadline) {
			Logf("%s failed on attempt %d: %v", what, attempt, err)
			return err
		}
		Logf("%s attempt %d failed, retrying: %v", what, attempt, err)
		time.Sleep(250 * time.Millisecond)
	}
}
func (t *Transaction) rename(from, to string) error {
	return t.retry("rename "+from+" -> "+to, func() error { return t.Rename(from, to) })
}

func New(target string, registration Registration) (*Transaction, error) {
	if !filepath.IsAbs(target) {
		return nil, errors.New("installation path must be absolute")
	}
	target = filepath.Clean(target)
	if filepath.Dir(target) == target || len(filepath.Base(target)) < 2 {
		return nil, errors.New("unsafe installation root")
	}
	if err := safePath(target); err != nil {
		return nil, err
	}
	dir := target + ".ccc-transaction"
	return &Transaction{target, dir, filepath.Join(dir, "new"), filepath.Join(dir, "previous"), registration, os.Rename, DefaultRetryFor}, nil
}
func safePath(p string) error {
	for {
		info, err := os.Lstat(p)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("linked path refused: %s", p)
		}
		parent := filepath.Dir(p)
		if parent == p {
			return nil
		}
		p = parent
	}
}
func exists(p string) bool { _, err := os.Lstat(p); return err == nil }
func (t *Transaction) read() (*Journal, error) {
	if err := safePath(t.Directory); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(t.Directory, "journal.json"))
	if err != nil {
		return nil, err
	}
	if len(b) > 64*1024 {
		return nil, errors.New("oversize journal")
	}
	var j Journal
	if err = json.Unmarshal(b, &j); err != nil {
		return nil, err
	}
	if j.Format != 1 || j.AppID != AppID || j.Target != t.Target {
		return nil, errors.New("unowned transaction directory")
	}
	switch j.Phase {
	case "preparing", "switching", "committed":
	default:
		return nil, errors.New("unknown transaction phase")
	}
	return &j, nil
}
func (t *Transaction) write(j *Journal) error {
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(t.Directory, "journal.next"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(filepath.Join(t.Directory, "journal.next"), filepath.Join(t.Directory, "journal.json"))
}

// Prepare refuses pre-existing unowned transaction paths and unrelated target
// contents. A registry implementation verifies the installed target's identity.
func (t *Transaction) Prepare() error {
	if exists(t.Directory) {
		return errors.New("pending transaction; recover it before installing")
	}
	var prior bool
	if exists(t.Target) {
		entries, err := os.ReadDir(t.Target)
		if err != nil {
			return err
		}
		prior = len(entries) > 0
		if prior {
			if err = validateAppSkeleton(t.Target); err != nil {
				return err
			}
		}
	}
	registration, err := t.Registry.Capture(t.Target)
	if err != nil {
		return err
	}
	if err = os.Mkdir(t.Directory, 0700); err != nil {
		return err
	}
	j := &Journal{1, AppID, t.Target, "preparing", prior, registration}
	if err = t.write(j); err != nil {
		return err
	}
	return os.Mkdir(t.Stage, 0700)
}
func validateAppSkeleton(dir string) error {
	for _, name := range []string{"Claude Country Club.exe", "resources/app.asar", "resources/ccc-hook.exe"} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := safePath(p); err != nil {
			return err
		}
		info, err := os.Stat(p)
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return fmt.Errorf("not a complete Country Club installation: %s", name)
		}
	}
	return nil
}

// Validate checks every packaged file and rejects extra files, links, missing
// files and bad digests. The NSIS-generated uninstaller/icon are the only extras.
func Validate(dir string) error {
	if err := safePath(dir); err != nil {
		return err
	}
	b, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		return err
	}
	if len(b) > 2*1024*1024 {
		return errors.New("oversize package manifest")
	}
	var m Manifest
	if err = json.Unmarshal(b, &m); err != nil {
		return err
	}
	if m.AppID != AppID || m.Version == "" || len(m.Files) == 0 || len(m.Files) > 10000 {
		return errors.New("invalid package manifest")
	}
	seen := map[string]bool{}
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("package contains linked file")
		}
		if d.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		if name == ManifestName || name == "Uninstall Claude Country Club.exe" || name == "uninstallerIcon.ico" {
			return nil
		}
		digest, ok := m.Files[name]
		if !ok {
			return fmt.Errorf("unlisted package file: %s", name)
		}
		if len(digest) != 64 || strings.ToLower(digest) != digest {
			return errors.New("invalid digest")
		}
		if _, err = hex.DecodeString(digest); err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return err
		}
		if hex.EncodeToString(h.Sum(nil)) != digest {
			return fmt.Errorf("package digest mismatch: %s", name)
		}
		seen[name] = true
		return nil
	})
	if err != nil {
		return err
	}
	if len(seen) != len(m.Files) {
		return errors.New("package files missing")
	}
	return validateAppSkeleton(dir)
}
func (t *Transaction) Commit() error {
	j, err := t.read()
	if err != nil {
		return err
	}
	if j.Phase != "preparing" {
		return errors.New("transaction is not prepared")
	}
	if err = Validate(t.Stage); err != nil {
		return err
	}
	j.Phase = "switching"
	if err = t.write(j); err != nil {
		return err
	}
	if j.Previous {
		if err = t.rename(t.Target, t.Backup); err != nil {
			return err
		}
	} else if exists(t.Target) {
		if err = os.Remove(t.Target); err != nil {
			return err
		}
	}
	if err = t.rename(t.Stage, t.Target); err != nil {
		if j.Previous {
			if rollbackErr := t.rename(t.Backup, t.Target); rollbackErr != nil {
				return fmt.Errorf("switch failed: %v; previous app retained at %s: %v", err, t.Backup, rollbackErr)
			}
		}
		return err
	}
	// The previous app stays on disk until NSIS finishes registry/shortcut writes.
	return nil
}

// Finalize is called only after registration and shortcuts were written.
func (t *Transaction) Finalize() error {
	j, err := t.read()
	if err != nil {
		return err
	}
	if j.Phase != "switching" {
		return errors.New("transaction was not switched")
	}
	if err = Validate(t.Target); err != nil {
		return err
	}
	j.Phase = "committed"
	if err = t.write(j); err != nil {
		return err
	}
	return t.removeOwnedTree()
}
func (t *Transaction) removeOwnedTree() error {
	if _, err := t.read(); err != nil {
		return err
	}
	// Reject links anywhere in the owned tree, including files not in a manifest.
	if err := filepath.WalkDir(t.Directory, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("linked transaction entry refused")
		}
		return nil
	}); err != nil {
		return err
	}
	entries, err := os.ReadDir(t.Directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		switch entry.Name() {
		case "new", "previous", "journal.json", "journal.next":
		default:
			return errors.New("unrecognized transaction entry preserved")
		}
	}
	// Keep the ownership journal until both large trees are gone. A locked
	// backup must remain recoverable on the next installer invocation.
	for _, tree := range []string{t.Stage, t.Backup} {
		if err = t.retry("remove "+tree, func() error { return os.RemoveAll(tree) }); err != nil {
			return err
		}
	}
	if err = os.Remove(filepath.Join(t.Directory, "journal.next")); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err = os.Remove(filepath.Join(t.Directory, "journal.json")); err != nil {
		return err
	}
	return os.Remove(t.Directory)
}

// Recover rolls back an interrupted switch or cleans a fully committed one.
// An edited replacement is preserved for manual recovery rather than deleted.
func (t *Transaction) Recover() error {
	if !exists(t.Directory) {
		return nil
	}
	j, err := t.read()
	if err != nil {
		return err
	}
	if j.Phase == "committed" {
		if err = Validate(t.Target); err != nil {
			return err
		}
		return t.removeOwnedTree()
	}
	if j.Phase == "switching" {
		if exists(t.Backup) {
			if exists(t.Target) {
				if err = Validate(t.Target); err != nil {
					return fmt.Errorf("replacement changed; previous app preserved: %w", err)
				}
				if exists(t.Stage) {
					return errors.New("ambiguous recovery tree")
				}
				if err = t.rename(t.Target, t.Stage); err != nil {
					return err
				}
			}
			if err = t.rename(t.Backup, t.Target); err != nil {
				return err
			}
		} else if !j.Previous && exists(t.Target) {
			if err = Validate(t.Target); err != nil {
				return err
			}
			if exists(t.Stage) {
				return errors.New("ambiguous fresh install recovery")
			}
			if err = t.rename(t.Target, t.Stage); err != nil {
				return err
			}
		} else if j.Previous && !exists(t.Target) {
			return errors.New("previous app missing; manual recovery required")
		}
	}
	if err = t.Registry.Restore(j.Registration); err != nil {
		return err
	}
	return t.removeOwnedTree()
}
