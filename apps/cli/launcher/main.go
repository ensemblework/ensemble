package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
)

func main() {
	signal.Ignore(os.Interrupt)

	executable, err := os.Executable()
	if err != nil {
		fatal("could not locate ensemble.exe", err)
	}
	binDir := filepath.Dir(executable)
	sidecarDir := filepath.Clean(filepath.Join(binDir, "..", "sidecar"))
	node := filepath.Join(sidecarDir, "node.exe")
	cli := filepath.Clean(filepath.Join(binDir, "..", "lib", "ensemble.mjs"))

	args := append([]string{cli}, os.Args[1:]...)
	cmd := exec.Command(node, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = withEnv(os.Environ(), map[string]string{
		"ENSEMBLE_LAUNCHER":    invokedPath(),
		"ENSEMBLE_SIDECAR_DIR": sidecarDir,
	})

	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			os.Exit(exit.ExitCode())
		}
		fatal("could not start bundled Ensemble CLI", err)
	}
}

func invokedPath() string {
	arg0 := os.Args[0]
	if filepath.IsAbs(arg0) {
		return filepath.Clean(arg0)
	}
	if strings.ContainsAny(arg0, `\/`) {
		if abs, err := filepath.Abs(arg0); err == nil {
			return filepath.Clean(abs)
		}
		return filepath.Clean(arg0)
	}
	if found, err := exec.LookPath(arg0); err == nil {
		if abs, err := filepath.Abs(found); err == nil {
			return filepath.Clean(abs)
		}
		return filepath.Clean(found)
	}
	if abs, err := filepath.Abs(arg0); err == nil {
		return filepath.Clean(abs)
	}
	return arg0
}

func withEnv(base []string, set map[string]string) []string {
	out := make([]string, 0, len(base)+len(set))
	replace := make(map[string]bool, len(set))
	for key := range set {
		if runtime.GOOS == "windows" {
			key = strings.ToUpper(key)
		}
		replace[key] = true
	}
	for _, entry := range base {
		name, _, ok := strings.Cut(entry, "=")
		if !ok {
			out = append(out, entry)
			continue
		}
		key := name
		if runtime.GOOS == "windows" {
			key = strings.ToUpper(name)
		}
		if replace[key] {
			continue
		}
		out = append(out, entry)
	}
	for key, value := range set {
		out = append(out, key+"="+value)
	}
	return out
}

func fatal(message string, err error) {
	fmt.Fprintf(os.Stderr, "ensemble.exe: %s: %v\n", message, err)
	os.Exit(1)
}
