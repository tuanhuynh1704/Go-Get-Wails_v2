package util

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

var reservedName = regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9\x{00b9}\x{00b2}\x{00b3}]|LPT[1-9\x{00b9}\x{00b2}\x{00b3}]) *(\.|$)`)

func TestFileNameMetadataAndURLFallback(t *testing.T) {
	for _, tc := range []struct{ name, disposition, url, want string }{
		{"header", `attachment; filename="metadata.bin"`, "https://example.invalid/url.bin", "metadata.bin"},
		{"extended", `attachment; filename="ascii.txt"; filename*=UTF-8''caf%C3%A9.txt`, "https://example.invalid/url.bin", "caf\u00e9.txt"},
		{"path_header", `attachment; filename="../../secret.txt"`, "https://example.invalid/url.bin", "_.._secret.txt"},
		{"malformed_header", `attachment; filename="unterminated`, "https://example.invalid/fallback.bin?name=other", "fallback.bin"},
		{"empty_header", `attachment; filename=""`, "https://example.invalid/fallback.bin", "fallback.bin"},
		{"url_escaped", "", "https://example.invalid/caf%C3%A9%20report.txt?download=other", "caf\u00e9 report.txt"},
		{"root", "", "https://example.invalid/", "download"},
		{"no_path", "", "https://example.invalid", "download"},
		{"bad_url", "", "http://%zz", "download"},
		{"whitespace_metadata", `attachment; filename="   "`, "https://example.invalid/a.bin", "download"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := FileName(tc.disposition, tc.url); got != tc.want {
				t.Errorf("FileName=%q, want %q", got, tc.want)
			}
		})
	}
}

func TestSanitizeFileNamePortableComponents(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"", "download"}, {"...", "download"}, {" \t\r\n", "___"},
		{" \u00a0\u2003...\u3000", "download"},
		{"  report.txt.  ", "report.txt"},
		{"a<>:\"/\\|?*b\x00\n", "a_________b__"},
		{"normal-file_1.tar.gz", "normal-file_1.tar.gz"},
		{"caf\u00e9-\u4e2d\u6587-\U0001f600.txt", "caf\u00e9-\u4e2d\u6587-\U0001f600.txt"},
		{string([]byte{'a', 0xff, 'b'}), "a_b"},
		{"CON", "_CON"}, {"con.txt", "_con.txt"}, {"CON .txt", "_CON .txt"},
		{"PRN", "_PRN"}, {"aux.log", "_aux.log"}, {"NUL", "_NUL"},
		{"CLOCK$", "_CLOCK$"}, {"CONIN$", "_CONIN$"}, {"CONOUT$.txt", "_CONOUT$.txt"},
		{"COM1.txt", "_COM1.txt"}, {"com9", "_com9"}, {"LPT1", "_LPT1"}, {"lpt9.log", "_lpt9.log"},
		{"COM\u00b9.txt", "_COM\u00b9.txt"}, {"com\u00b2", "_com\u00b2"}, {"LPT\u00b3", "_LPT\u00b3"},
		{"COM0", "COM0"}, {"COM10", "COM10"}, {"LPT0", "LPT0"}, {"COM\u2074", "COM\u2074"},
	} {
		t.Run(fmt.Sprintf("%q", tc.input), func(t *testing.T) {
			got := SanitizeFileName(tc.input)
			if got != tc.want {
				t.Errorf("SanitizeFileName(%q)=%q, want %q", tc.input, got, tc.want)
			}
			assertPortableName(t, tc.input, got)
		})
	}
}

func assertPortableName(t testing.TB, input, got string) {
	t.Helper()
	if reservedName.MatchString(got) {
		t.Errorf("reserved Windows filename remains: input=%q output=%q", input, got)
	}
	if got == "" || got == "." || got == ".." || filepath.Base(got) != got || filepath.IsAbs(got) {
		t.Errorf("not a single filename: input=%q output=%q", input, got)
	}
	if !utf8.ValidString(got) || len(got) > 180 {
		t.Errorf("invalid encoding or byte bound: len=%d, input=%q output=%q", len(got), input, got)
	}
	for _, r := range got {
		if unicode.IsControl(r) || strings.ContainsRune(`<>:"/\|?*`, r) {
			t.Errorf("unsafe rune %U in %q", r, got)
		}
	}
	if strings.TrimFunc(got, func(r rune) bool { return r == '.' || unicode.IsSpace(r) }) != got {
		t.Errorf("unsafe filename edges: %q", got)
	}
	if again := SanitizeFileName(got); again != got {
		t.Errorf("sanitizer not idempotent: %q -> %q -> %q", input, got, again)
	}
}

func TestSanitizeTruncationAndIdempotence(t *testing.T) {
	for _, input := range []string{
		strings.Repeat("a", 181),
		strings.Repeat("\u4e2d", 100),
		strings.Repeat("\U0001f600", 100),
		strings.Repeat("a", 179) + "\u4e2d",
		strings.Repeat("a", 179) + ".suffix",
		"CON." + strings.Repeat("a", 176),
		"LPT\u00b9." + strings.Repeat("z", 200),
	} {
		t.Run(fmt.Sprintf("bytes_%d_prefix_%s", len(input), input[:min(5, len(input))]), func(t *testing.T) { assertPortableName(t, input, SanitizeFileName(input)) })
	}
}

func FuzzSanitizeFileName(f *testing.F) {
	for _, seed := range []string{"", ".", "../CON.txt", "LPT\u00b9.log", "COM\u00b2", "\u00a0\u2003", "\x00\xff", "caf\u00e9-\U0001f600.txt", strings.Repeat("\u4e2d", 100), "CON." + strings.Repeat("a", 176)} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) { assertPortableName(t, input, SanitizeFileName(input)) })
}
