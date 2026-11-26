package downloader

import "golang.org/x/sys/unix"

func publishFile(source, target string) error {
	return unix.RenamexNp(source, target, unix.RENAME_EXCL)
}
