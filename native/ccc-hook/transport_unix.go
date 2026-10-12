//go:build !windows

package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

func listen(p string) (net.Listener, error) {
	dir := filepath.Dir(p)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("socket directory must be private")
	}
	if _, err = os.Lstat(p); err == nil {
		return nil, fmt.Errorf("socket already exists")
	}
	l, err := net.Listen("unix", p)
	if err == nil {
		err = os.Chmod(p, 0600)
		if err != nil {
			l.Close()
		}
	}
	return l, err
}
func dial(p string, d time.Duration) (net.Conn, error) { return net.DialTimeout("unix", p, d) }
func cleanup(p string)                                 { _ = os.Remove(p) }
