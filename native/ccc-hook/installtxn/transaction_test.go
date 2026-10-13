package installtxn

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// realTempDir resolves symlinked temp roots (macOS /var -> /private/var) so the
// production linked-path refusal stays strict and tests exercise it unchanged.
func realTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

type fakeRegistration struct{ restored bool }

func (r *fakeRegistration) Capture(string) (json.RawMessage, error) {
	return json.RawMessage(`{"version":"old"}`), nil
}
func (r *fakeRegistration) Restore(b json.RawMessage) error { r.restored = true; return nil }
func bundle(t *testing.T, dir, version string) {
	t.Helper()
	files := map[string]string{}
	for _, name := range []string{"Claude Country Club.exe", "resources/app.asar", "resources/ccc-hook.exe"} {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		data := []byte(version + name)
		if err := os.WriteFile(p, data, 0600); err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256(data)
		files[name] = hex.EncodeToString(h[:])
	}
	b, _ := json.Marshal(Manifest{AppID, version, files})
	if err := os.WriteFile(filepath.Join(dir, ManifestName), b, 0600); err != nil {
		t.Fatal(err)
	}
}
func fixture(t *testing.T, prior bool) (*Transaction, *fakeRegistration) {
	t.Helper()
	target := filepath.Join(realTempDir(t), "app")
	if prior {
		bundle(t, target, "old")
	}
	r := &fakeRegistration{}
	tx, err := New(target, r)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Prepare(); err != nil {
		t.Fatal(err)
	}
	bundle(t, tx.Stage, "new")
	return tx, r
}
func version(t *testing.T, dir string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		t.Fatal(err)
	}
	var m Manifest
	if err = json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m.Version
}
func TestCommitRetainsPreviousUntilFinalize(t *testing.T) {
	tx, _ := fixture(t, true)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if version(t, tx.Target) != "new" || version(t, tx.Backup) != "old" {
		t.Fatal("swap lost version")
	}
	if err := tx.Finalize(); err != nil {
		t.Fatal(err)
	}
	if exists(tx.Directory) {
		t.Fatal("finalized journal remains")
	}
}
func TestFailedRenameRestoresPrevious(t *testing.T) {
	tx, r := fixture(t, true)
	tx.RetryFor = 0
	tx.Rename = func(a, b string) error {
		if a == tx.Stage {
			return errors.New("injected extraction promotion failure")
		}
		return os.Rename(a, b)
	}
	if tx.Commit() == nil {
		t.Fatal("expected injected failure")
	}
	if version(t, tx.Target) != "old" {
		t.Fatal("old app lost")
	}
	if err := tx.Recover(); err != nil {
		t.Fatal(err)
	}
	if !r.restored || exists(tx.Directory) {
		t.Fatal("rollback incomplete")
	}
}
func TestInterruptedSwitchRollsBackAndRestoresRegistration(t *testing.T) {
	tx, r := fixture(t, true)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Recover(); err != nil {
		t.Fatal(err)
	}
	if version(t, tx.Target) != "old" || !r.restored {
		t.Fatal("recovery incomplete")
	}
}
func TestInterruptionAfterMovingPrevious(t *testing.T) {
	tx, _ := fixture(t, true)
	j, _ := tx.read()
	j.Phase = "switching"
	if err := tx.write(j); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tx.Target, tx.Backup); err != nil {
		t.Fatal(err)
	}
	if err := tx.Recover(); err != nil {
		t.Fatal(err)
	}
	if version(t, tx.Target) != "old" {
		t.Fatal("previous app not restored")
	}
}
func TestInterruptedFreshInstall(t *testing.T) {
	tx, r := fixture(t, false)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Recover(); err != nil {
		t.Fatal(err)
	}
	if exists(tx.Target) || !r.restored {
		t.Fatal("fresh install rollback incomplete")
	}
}
func TestCorruptStageLeavesPreviousUntouched(t *testing.T) {
	tx, _ := fixture(t, true)
	if err := os.WriteFile(filepath.Join(tx.Stage, "resources/app.asar"), []byte("bad"), 0600); err != nil {
		t.Fatal(err)
	}
	if tx.Commit() == nil {
		t.Fatal("corrupt stage accepted")
	}
	if version(t, tx.Target) != "old" {
		t.Fatal("old app changed")
	}
	if err := tx.Recover(); err != nil {
		t.Fatal(err)
	}
}
func TestEditedReplacementPreservesBothCopies(t *testing.T) {
	tx, _ := fixture(t, true)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tx.Target, "resources/app.asar"), []byte("user modification"), 0600); err != nil {
		t.Fatal(err)
	}
	if tx.Recover() == nil {
		t.Fatal("edited replacement deleted")
	}
	if !exists(tx.Backup) || !exists(tx.Target) || !exists(tx.Directory) {
		t.Fatal("recovery evidence lost")
	}
}
func TestUnownedPathsAreRefused(t *testing.T) {
	r := &fakeRegistration{}
	target := filepath.Join(realTempDir(t), "documents")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "personal.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	tx, err := New(target, r)
	if err != nil {
		t.Fatal(err)
	}
	if tx.Prepare() == nil {
		t.Fatal("unowned target accepted")
	}
	if err := os.Mkdir(tx.Directory, 0700); err != nil {
		t.Fatal(err)
	}
	if tx.Recover() == nil {
		t.Fatal("unowned transaction accepted")
	}
	if !exists(filepath.Join(target, "personal.txt")) {
		t.Fatal("unowned file lost")
	}
}
func TestMissingAndExtraFilesRefused(t *testing.T) {
	for _, kind := range []string{"missing", "extra"} {
		t.Run(kind, func(t *testing.T) {
			tx, _ := fixture(t, true)
			if kind == "missing" {
				os.Remove(filepath.Join(tx.Stage, "resources/app.asar"))
			} else {
				os.WriteFile(filepath.Join(tx.Stage, "surprise.txt"), []byte("bad"), 0600)
			}
			if Validate(tx.Stage) == nil {
				t.Fatal("bad package accepted")
			}
		})
	}
}
func TestCommittedCleanupCanResume(t *testing.T) {
	tx, _ := fixture(t, true)
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	j, _ := tx.read()
	j.Phase = "committed"
	if err := tx.write(j); err != nil {
		t.Fatal(err)
	}
	if err := tx.Recover(); err != nil {
		t.Fatal(err)
	}
	if version(t, tx.Target) != "new" || exists(tx.Directory) {
		t.Fatal("committed cleanup rolled back")
	}
}

func TestUnexpectedRecoveryFilesArePreserved(t *testing.T) {
	tx, _ := fixture(t, true)
	unexpected := filepath.Join(tx.Directory, "personal.txt")
	if err := os.WriteFile(unexpected, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if tx.Recover() == nil {
		t.Fatal("unexpected recovery contents removed")
	}
	if !exists(unexpected) || !exists(filepath.Join(tx.Directory, "journal.json")) {
		t.Fatal("ownership or unrelated file lost")
	}
}
