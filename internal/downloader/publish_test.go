package downloader

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestPublishFileRefusesExistingDestination(t *testing.T) {
	dir := t.TempDir()
	source, target := filepath.Join(dir, "source.goget"), filepath.Join(dir, "target.bin")
	if err := os.WriteFile(source, []byte("new bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("existing bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := publishFile(source, target); err == nil {
		t.Error("publication accepted existing destination")
	}
	assertFiles(t, dir, map[string][]byte{"source.goget": []byte("new bytes"), "target.bin": []byte("existing bytes")})
}

func TestPublishFileConcurrentWinners(t *testing.T) {
	const contenders = 20
	dir := t.TempDir()
	target := filepath.Join(dir, "winner.bin")
	start := make(chan struct{})
	type result struct {
		index int
		err   error
	}
	results := make(chan result, contenders)
	var wg sync.WaitGroup
	for i := 0; i < contenders; i++ {
		source := filepath.Join(dir, fmt.Sprintf("source-%d.goget", i))
		if err := os.WriteFile(source, []byte(fmt.Sprintf("contender-%d", i)), 0o600); err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func(index int, source string) {
			defer wg.Done()
			<-start
			results <- result{index, publishFile(source, target)}
		}(i, source)
	}
	close(start)
	wg.Wait()
	close(results)
	winner := -1
	want := make(map[string][]byte)
	for r := range results {
		if r.err == nil {
			if winner != -1 {
				t.Fatalf("multiple atomic publication winners: %d and %d", winner, r.index)
			}
			winner = r.index
		} else {
			want[fmt.Sprintf("source-%d.goget", r.index)] = []byte(fmt.Sprintf("contender-%d", r.index))
		}
	}
	if winner == -1 {
		t.Fatal("no publication succeeded")
	}
	want["winner.bin"] = []byte(fmt.Sprintf("contender-%d", winner))
	assertFiles(t, dir, want)
}

func TestReservePublishAndCleanupOwnership(t *testing.T) {
	dir := t.TempDir()
	f, err := reserveFiles(dir, "payload.bin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(f.target); !os.IsNotExist(err) {
		t.Errorf("reservation exposed destination: %v", err)
	}
	if _, err := f.file.Write([]byte("owned content")); err != nil {
		t.Fatal(err)
	}
	if err := f.file.Close(); err != nil {
		t.Fatal(err)
	}
	f.file = nil
	if err := f.publish(); err != nil {
		t.Fatal(err)
	}
	if err := f.cleanup(); err != nil {
		t.Errorf("cleanup after publication: %v", err)
	}
	if err := f.cleanup(); err != nil {
		t.Errorf("repeat cleanup: %v", err)
	}
	assertFiles(t, dir, map[string][]byte{"payload.bin": []byte("owned content")})
}

func TestCleanupRefusesReplacedTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	f, err := reserveFiles(dir, "payload.bin")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.file.Close(); err != nil {
		t.Fatal(err)
	}
	f.file = nil
	// Keep the original inode alive so replacement cannot reuse its identity.
	if err := os.Rename(f.temp, filepath.Join(dir, "original-owned-file")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.temp, []byte("external temporary file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.publish(); err == nil {
		t.Error("publication accepted a replaced temporary file")
	}
	if err := f.cleanup(); err == nil {
		t.Error("cleanup accepted a replaced temporary file")
	}
	got, err := os.ReadFile(f.temp)
	if err != nil || !bytes.Equal(got, []byte("external temporary file")) {
		t.Errorf("cleanup removed external temporary file: %q %v", got, err)
	}
	if _, err := os.Stat(f.target); !os.IsNotExist(err) {
		t.Errorf("unowned file was published: %v", err)
	}
}

func TestReserveRefusesTraversal(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"../escaped.bin", filepath.Join("..", "escaped.bin")} {
		f, err := reserveFiles(dir, name)
		if err == nil {
			_ = f.cleanup()
			t.Errorf("reservation accepted traversal %q", name)
		}
	}
	assertFiles(t, dir, nil)
}
