const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
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

function readFileViaStream(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (error) => reject(error));
    stream.on('end', () => resolve(chunks.join('')));
  });
}

function parseInputInWorker(text) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'parse-worker.js');
    const worker = new Worker(workerPath, {
      workerData: { text: String(text || '') }
    });

    worker.once('message', (result) => {
      resolve(result);
    });
    worker.once('error', (error) => {
      reject(error);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Parse worker exited with code ${code}`));
      }
    });
  });
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
              const content = await readFileViaStream(selectedPath);
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
        {
          label: 'Save File',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            const window = getFocusedWindow();
            if (!window) {
              return;
            }
            window.webContents.send('menu-save-file-request');
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
      const content = await readFileViaStream(selectedPath);
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

  ipcMain.handle('save-file-dialog', async (_event, request) => {
    const window = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!window) {
      return { ok: false, error: 'No active window.' };
    }

    const content = typeof request?.content === 'string' ? request.content : '';
    const existingPath = typeof request?.filePath === 'string' ? request.filePath : '';
    const suggestedFileName = typeof request?.fileName === 'string' ? request.fileName : 'structview-data.json';

    try {
      if (existingPath) {
        await fs.promises.writeFile(existingPath, content, 'utf8');
        return {
          ok: true,
          filePath: existingPath,
          fileName: path.basename(existingPath)
        };
      }

      const saveResult = await dialog.showSaveDialog(window, {
        defaultPath: suggestedFileName,
        filters: [
          { name: 'Structured Data', extensions: ['json', 'yaml', 'yml'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return { ok: false, canceled: true };
      }

      await fs.promises.writeFile(saveResult.filePath, content, 'utf8');
      return {
        ok: true,
        filePath: saveResult.filePath,
        fileName: path.basename(saveResult.filePath)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('parse-input-async', async (_event, text) => {
    try {
      return await parseInputInWorker(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Parser worker failed: ${message}` };
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
