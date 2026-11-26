package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title: "GoGet", Width: 1100, Height: 760,
		MinWidth: 800, MinHeight: 520,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 247, G: 249, B: 249, A: 1},
		OnStartup:        app.startup, OnBeforeClose: app.beforeClose, OnShutdown: app.shutdown,
		Bind: []interface{}{app},
	})
	if err != nil {
		log.Fatal(err)
	}
}
