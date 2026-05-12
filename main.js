const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const iconPath = path.join(__dirname, 'assets', 'structview-logo.png');

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'StructView',
    backgroundColor: '#0b1020',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.loadFile(path.join(__dirname, 'index.html'));
  return window;
}

function createAppMenu(getFocusedWindow) {
  const template = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open File',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const window = getFocusedWindow();
            if (!window) {
              return;
            }

            const result = await dialog.showOpenDialog(window, {
              properties: ['openFile'],
              filters: [
                { name: 'Structured Data', extensions: ['json', 'yaml', 'yml'] },
                { name: 'All Files', extensions: ['*'] }
              ]
            });

            if (result.canceled || result.filePaths.length === 0) {
              return;
            }

            const selectedPath = result.filePaths[0];
            try {
              const content = fs.readFileSync(selectedPath, 'utf8');
              window.webContents.send('menu-open-file', {
                filePath: selectedPath,
                fileName: path.basename(selectedPath),
                content
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              dialog.showErrorBox('Open File Failed', `Unable to open file:\n${message}`);
            }
          }
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }

  const mainWindow = createWindow();
  createAppMenu(() => BrowserWindow.getFocusedWindow() || mainWindow);

  ipcMain.handle('open-file-dialog', async () => {
    const window = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!window) {
      return { ok: false, error: 'No active window.' };
    }

    try {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [
          { name: 'Structured Data', extensions: ['json', 'yaml', 'yml'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }

      const selectedPath = result.filePaths[0];
      const content = fs.readFileSync(selectedPath, 'utf8');
      return {
        ok: true,
        filePath: selectedPath,
        fileName: path.basename(selectedPath),
        content
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
