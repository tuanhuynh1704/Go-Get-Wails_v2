package downloader

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsLongPathNormalization(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{`C:\downloads\..\file.bin`, `\\?\C:\file.bin`},
		{`\\server\share\file.bin`, `\\?\UNC\server\share\file.bin`},
		{`\\?\C:\file.bin`, `\\?\C:\file.bin`},
		{`relative\file.bin`, `relative\file.bin`},
	} {
		if got := longPath(tc.input); got != tc.want {
			t.Errorf("longPath(%q)=%q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestWindowsPublishRejectsInvalidPaths(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source.goget")
	if err := os.WriteFile(source, []byte("owned source"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishFile(source+"\x00", filepath.Join(dir, "target.bin")); err == nil {
		t.Error("accepted NUL in source")
	}
	if err := publishFile(source, filepath.Join(dir, "target.bin")+"\x00"); err == nil {
		t.Error("accepted NUL in target")
	}
	assertFiles(t, dir, map[string][]byte{"source.goget": []byte("owned source")})
}
