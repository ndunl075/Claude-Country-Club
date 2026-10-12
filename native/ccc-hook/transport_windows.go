//go:build windows

package main

import (
	"fmt"
	winio "github.com/Microsoft/go-winio"
	"net"
	"os/user"
	"strings"
	"time"
)

func listen(p string) (net.Listener, error) {
	if !strings.HasPrefix(p, `\\.\pipe\country-club-`) {
		return nil, fmt.Errorf("invalid pipe namespace")
	}
	u, err := user.Current()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(p, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + u.Uid + ")", MessageMode: false, InputBufferSize: 16384, OutputBufferSize: 16384})
}
func dial(p string, d time.Duration) (net.Conn, error) { return winio.DialPipe(p, &d) }
func cleanup(string)                                   {}
