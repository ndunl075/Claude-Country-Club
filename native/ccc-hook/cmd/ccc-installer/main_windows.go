package main

import (
	"countryclub/hook/installtxn"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const maxLogBytes = 64 * 1024

// openLog appends to a bounded per-user diagnostic file. Silent installs show no
// installer details, so this is the only record of why a stage failed or which
// filesystem operation had to be retried. Logging never changes the outcome.
func openLog() *os.File {
	path := filepath.Join(os.TempDir(), "ccc-installer.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if info, err := os.Stat(path); err == nil && info.Size() > maxLogBytes {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0600)
	if err != nil {
		return nil
	}
	return f
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "Expected prepare, commit, finalize or recover and an absolute install directory.")
		os.Exit(5)
	}
	if log := openLog(); log != nil {
		defer log.Close()
		installtxn.Logf = func(format string, args ...any) {
			fmt.Fprintf(log, "%s pid=%d %s\n", time.Now().UTC().Format("15:04:05.000"), os.Getpid(), fmt.Sprintf(format, args...))
		}
		installtxn.Logf("%s %s", os.Args[1], os.Args[2])
	}
	tx, err := installtxn.New(os.Args[2], installtxn.WindowsRegistration{})
	if err == nil {
		switch os.Args[1] {
		case "prepare":
			err = tx.Prepare()
		case "commit":
			err = tx.Commit()
		case "finalize":
			err = tx.Finalize()
		case "recover":
			err = tx.Recover()
		default:
			err = fmt.Errorf("unknown installer action")
		}
	}
	if err != nil {
		installtxn.Logf("%s failed: %v", os.Args[1], err)
		fmt.Fprintln(os.Stderr, err)
		os.Exit(5)
	}
	installtxn.Logf("%s ok", os.Args[1])
}
