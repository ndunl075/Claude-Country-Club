package installtxn

import (
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/windows/registry"
	"path/filepath"
	"strings"
)

// Fixed product keys: journal contents can never select another registry path.
const ProductGUID = "e0e2b6b5-dc94-506c-b07b-3fd5ab2393ac"

var productKeys = []string{`Software\` + ProductGUID, `Software\Microsoft\Windows\CurrentVersion\Uninstall\` + ProductGUID}

type registryValue struct {
	Kind   uint32 `json:"kind"`
	Text   string `json:"text,omitempty"`
	Number uint64 `json:"number,omitempty"`
	Binary []byte `json:"binary,omitempty"`
}
type registrySnapshot struct {
	Exists bool                     `json:"exists"`
	Values map[string]registryValue `json:"values"`
}
type WindowsRegistration struct{}

func (WindowsRegistration) Capture(target string) (json.RawMessage, error) {
	result := make([]registrySnapshot, len(productKeys))
	for i, p := range productKeys {
		k, err := registry.OpenKey(registry.CURRENT_USER, p, registry.READ|registry.WOW64_64KEY)
		if errors.Is(err, registry.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		snapshot := registrySnapshot{Exists: true, Values: map[string]registryValue{}}
		names, err := k.ReadValueNames(0)
		if err != nil {
			k.Close()
			return nil, err
		}
		for _, name := range names {
			_, kind, err := k.GetValue(name, nil)
			if err != nil {
				k.Close()
				return nil, err
			}
			v := registryValue{Kind: kind}
			switch kind {
			case registry.SZ, registry.EXPAND_SZ:
				v.Text, _, err = k.GetStringValue(name)
			case registry.DWORD, registry.QWORD:
				v.Number, _, err = k.GetIntegerValue(name)
			case registry.BINARY:
				v.Binary, _, err = k.GetBinaryValue(name)
			default:
				err = fmt.Errorf("unsupported Country Club registry value type: %d", kind)
			}
			if err != nil {
				k.Close()
				return nil, err
			}
			snapshot.Values[name] = v
		}
		k.Close()
		result[i] = snapshot
	}
	if result[0].Exists {
		location := result[0].Values["InstallLocation"].Text
		if location == "" || !strings.EqualFold(filepath.Clean(location), target) {
			return nil, errors.New("registered installation is at another path")
		}
	}
	if result[1].Exists {
		uninstall := result[1].Values["UninstallString"].Text
		expected := `"` + filepath.Join(target, "Uninstall Claude Country Club.exe") + `"`
		if !strings.HasPrefix(strings.ToLower(uninstall), strings.ToLower(expected)) {
			return nil, errors.New("registered uninstaller is at another path")
		}
	}
	return json.Marshal(result)
}
func (WindowsRegistration) Restore(data json.RawMessage) error {
	var snapshots []registrySnapshot
	if err := json.Unmarshal(data, &snapshots); err != nil {
		return err
	}
	if len(snapshots) != len(productKeys) {
		return errors.New("invalid registration backup")
	}
	for i, p := range productKeys {
		snapshot := snapshots[i]
		if !snapshot.Exists {
			err := registry.DeleteKey(registry.CURRENT_USER, p)
			if err != nil && !errors.Is(err, registry.ErrNotExist) {
				return err
			}
			continue
		}
		k, _, err := registry.CreateKey(registry.CURRENT_USER, p, registry.ALL_ACCESS|registry.WOW64_64KEY)
		if err != nil {
			return err
		}
		names, err := k.ReadValueNames(0)
		if err != nil {
			k.Close()
			return err
		}
		for _, name := range names {
			if _, ok := snapshot.Values[name]; !ok {
				if err = k.DeleteValue(name); err != nil {
					k.Close()
					return err
				}
			}
		}
		for name, v := range snapshot.Values {
			switch v.Kind {
			case registry.SZ:
				err = k.SetStringValue(name, v.Text)
			case registry.EXPAND_SZ:
				err = k.SetExpandStringValue(name, v.Text)
			case registry.DWORD:
				err = k.SetDWordValue(name, uint32(v.Number))
			case registry.QWORD:
				err = k.SetQWordValue(name, v.Number)
			case registry.BINARY:
				err = k.SetBinaryValue(name, v.Binary)
			default:
				err = errors.New("invalid registration backup value")
			}
			if err != nil {
				k.Close()
				return err
			}
		}
		k.Close()
	}
	return nil
}
