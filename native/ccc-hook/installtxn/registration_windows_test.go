package installtxn

import (
	"golang.org/x/sys/windows/registry"
	"path/filepath"
	"testing"
)

func TestRegistrationSnapshotRestoresOnlyScopedFixtureKeys(t *testing.T) {
	target := filepath.Join(t.TempDir(), "app")
	original := productKeys
	fixtureRoot := `Software\CountryClubInstallerTests\` + filepath.Base(filepath.Dir(target))
	productKeys = []string{fixtureRoot + `\App`, fixtureRoot + `\Uninstall`}
	defer func() {
		for _, p := range productKeys {
			registry.DeleteKey(registry.CURRENT_USER, p)
		}
		registry.DeleteKey(registry.CURRENT_USER, fixtureRoot)
		productKeys = original
	}()
	r := WindowsRegistration{}
	empty, err := r.Capture(target)
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range productKeys {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, p, registry.ALL_ACCESS|registry.WOW64_64KEY)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			k.SetStringValue("InstallLocation", target)
		} else {
			k.SetStringValue("UninstallString", `"`+filepath.Join(target, "Uninstall Claude Country Club.exe")+`" /currentuser`)
		}
		k.SetStringValue("DisplayVersion", "0.1.0")
		k.SetDWordValue("NoRepair", 1)
		k.Close()
	}
	before, err := r.Capture(target)
	if err != nil {
		t.Fatal(err)
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, productKeys[1], registry.ALL_ACCESS|registry.WOW64_64KEY)
	if err != nil {
		t.Fatal(err)
	}
	k.SetStringValue("DisplayVersion", "0.2.0")
	k.SetStringValue("AddedDuringInstall", "remove")
	k.Close()
	if err = r.Restore(before); err != nil {
		t.Fatal(err)
	}
	after, err := r.Capture(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("registration did not restore exactly")
	}
	if _, err = r.Capture(filepath.Join(filepath.Dir(target), "another-app")); err == nil {
		t.Fatal("different registered target accepted")
	}
	if err = r.Restore(empty); err != nil {
		t.Fatal(err)
	}
	for _, p := range productKeys {
		k, err = registry.OpenKey(registry.CURRENT_USER, p, registry.READ|registry.WOW64_64KEY)
		if err == nil {
			k.Close()
			t.Fatal("fresh-install rollback left test registration")
		}
	}
}
