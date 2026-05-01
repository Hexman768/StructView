const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'assets', 'structview-logo.svg');
const pngPath = path.join(__dirname, '..', 'assets', 'structview-logo.png');

async function render() {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const html = `<!doctype html><html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;"><div style="width:1024px;height:1024px;">${svg}</div></body></html>`;
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const win = new BrowserWindow({
    useContentSize: true,
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadURL(dataUrl);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(pngPath, image.toPNG());
  await win.destroy();
}

app.whenReady()
  .then(render)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
