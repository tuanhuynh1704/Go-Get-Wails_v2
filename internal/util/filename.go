package util

import (
	"mime"
	"net/url"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"
)

// FileName prefers RFC 6266 metadata, including filename*, over the URL path.
func FileName(disposition, rawURL string) string {
	if _, params, err := mime.ParseMediaType(disposition); err == nil && params["filename"] != "" {
		return SanitizeFileName(params["filename"])
	}
	if u, err := url.Parse(rawURL); err == nil {
		if name := path.Base(u.Path); name != "." && name != "/" {
			return SanitizeFileName(name)
		}
	}
	return "download"
}

// SanitizeFileName produces a single portable path component, including on Windows.
func SanitizeFileName(name string) string {
	name = strings.ToValidUTF8(name, "_")
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	trim := func(r rune) bool { return r == '.' || unicode.IsSpace(r) }
	name = strings.TrimFunc(name, trim)
	if name == "" {
		return "download"
	}
	// Bound encoded bytes as well as characters, leaving room for collision suffixes.
	var b strings.Builder
	for _, r := range name {
		if b.Len()+len(string(r)) > 180 {
			break
		}
		b.WriteRune(r)
	}
	name = strings.TrimRightFunc(b.String(), trim)
	if name == "" {
		return "download"
	}
	stem := strings.ToUpper(strings.TrimRight(strings.SplitN(name, ".", 2)[0], " "))
	reserved := stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || stem == "CLOCK$" || stem == "CONIN$" || stem == "CONOUT$"
	if utf8.RuneCountInString(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) {
		digit, _ := utf8.DecodeRuneInString(stem[3:])
		reserved = strings.ContainsRune("123456789¹²³", digit)
	}
	if reserved {
		for len(name) >= 180 {
			_, size := utf8.DecodeLastRuneInString(name)
			name = name[:len(name)-size]
		}
		name = strings.TrimRightFunc(name, trim)
		name = "_" + name
	}
	return name
}
