package main

import (
	"countryclub/hook/installtxn"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "Expected prepare, commit, finalize or recover and an absolute install directory.")
		os.Exit(5)
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
		fmt.Fprintln(os.Stderr, err)
		os.Exit(5)
	}
}
