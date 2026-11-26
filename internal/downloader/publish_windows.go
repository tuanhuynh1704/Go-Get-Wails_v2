package downloader

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// MoveFile fails if the destination exists, including on FAT/exFAT volumes.
func publishFile(source, target string) error {
	from, err := windows.UTF16PtrFromString(longPath(source))
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(longPath(target))
	if err != nil {
		return err
	}
	return windows.MoveFile(from, to)
}

func longPath(path string) string {
	path = filepath.Clean(path)
	if strings.HasPrefix(path, `\\?\`) {
		return path
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + path[2:]
	}
	if filepath.IsAbs(path) {
		return `\\?\` + path
	}
	return path
}
