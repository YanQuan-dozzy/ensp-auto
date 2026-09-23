const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const HTML = path.join(ROOT, 'tools', 'logo-template.html')
const OUT = path.join(ROOT, 'resources', 'src', 'enspauto-logo.png')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    enableLargerThanScreen: true,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      offscreen: true
    }
  })
  win.setContentSize(1024, 1024)
  await win.loadURL('file:///' + HTML.replace(/\\/g, '/'))
  await new Promise(r => setTimeout(r, 600))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.writeFileSync(OUT, image.toPNG())
  console.log(`Rendered logo to ${OUT} (${image.getSize().width}x${image.getSize().height})`)
  app.quit()
})
