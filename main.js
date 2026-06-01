const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const iconPath = path.join(__dirname, 'assets', 'structview-logo.png');
const goBackendEntry = path.join(__dirname, 'backend', 'cmd', 'structviewd');

let goBackendProcess = null;
let goBackendBuffer = '';
let goRequestSeq = 1;
const goPendingRequests = new Map();

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

function searchStructureInWorker(source, query, limit = 2000) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'search-worker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        source: String(source || ''),
        query: String(query || ''),
        limit: Number(limit) || 2000
      }
    });

    worker.once('message', (result) => {
      resolve(result);
    });
    worker.once('error', (error) => {
      reject(error);
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Search worker exited with code ${code}`));
      }
    });
  });
}

function rejectAllGoPending(message) {
  goPendingRequests.forEach(({ reject }) => {
    reject(new Error(message));
  });
  goPendingRequests.clear();
}

function handleGoBackendStdout(chunk) {
  goBackendBuffer += chunk.toString('utf8');
  let newlineIndex = goBackendBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const rawLine = goBackendBuffer.slice(0, newlineIndex).trim();
    goBackendBuffer = goBackendBuffer.slice(newlineIndex + 1);

    if (rawLine) {
      try {
        const payload = JSON.parse(rawLine);
        const pending = goPendingRequests.get(payload.id);
        if (pending) {
          goPendingRequests.delete(payload.id);
          if (!payload.ok) {
            pending.reject(new Error(payload.error || 'Unknown Go backend error.'));
          } else {
            pending.resolve(payload.result);
          }
        }
      } catch (error) {
        console.error('Invalid Go backend response:', rawLine, error);
      }
    }

    newlineIndex = goBackendBuffer.indexOf('\n');
  }
}

function ensureGoBackend() {
  if (goBackendProcess && !goBackendProcess.killed && goBackendProcess.exitCode === null && goBackendProcess.signalCode === null) {
    return goBackendProcess;
  }

  goBackendBuffer = '';
  goBackendProcess = spawn('go', ['run', goBackendEntry], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  goBackendProcess.stdout.on('data', handleGoBackendStdout);
  goBackendProcess.stderr.on('data', (chunk) => {
    const message = chunk.toString('utf8').trim();
    if (message) {
      console.error(`[go-backend] ${message}`);
    }
  });

  if (goBackendProcess.stdin) {
    goBackendProcess.stdin.on('error', (error) => {
      const details = `Go backend stdin error: ${error.message}`;
      rejectAllGoPending(details);
      goBackendProcess = null;
    });
  }

  goBackendProcess.on('exit', (code, signal) => {
    const details = `Go backend exited (code=${code}, signal=${signal || 'none'})`;
    rejectAllGoPending(details);
    goBackendProcess = null;
  });

  goBackendProcess.on('error', (error) => {
    const details = `Failed to start Go backend: ${error.message}`;
    rejectAllGoPending(details);
    goBackendProcess = null;
  });

  return goBackendProcess;
}

function requestGoBackend(method, params) {
  return new Promise((resolve, reject) => {
    const proc = ensureGoBackend();
    const stdinClosed =
      !proc ||
      !proc.stdin ||
      proc.killed ||
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      proc.stdin.destroyed ||
      proc.stdin.writableEnded;
    if (stdinClosed) {
      reject(new Error('Go backend is not available.'));
      return;
    }

    const id = goRequestSeq;
    goRequestSeq += 1;
    goPendingRequests.set(id, { resolve, reject });

    const payload = JSON.stringify({ id, method, params });
    try {
      proc.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return;
        }
        goPendingRequests.delete(id);
        reject(new Error(`Failed to send request to Go backend: ${error.message}`));
      });
    } catch (error) {
      goPendingRequests.delete(id);
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`Failed to send request to Go backend: ${message}`));
    }
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
      return await requestGoBackend('parse', { text: text || '' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        return await parseInputInWorker(text);
      } catch (_fallbackError) {
        return { ok: false, error: `Go parser failed: ${message}` };
      }
    }
  });

  ipcMain.handle('search-structure-async', async (_event, payload) => {
    try {
      const source = payload && typeof payload.source === 'string' ? payload.source : '';
      const query = payload && typeof payload.query === 'string' ? payload.query : '';
      const limit = payload && typeof payload.limit === 'number' ? payload.limit : 2000;
      const docKey = payload && typeof payload.docKey === 'string' ? payload.docKey : '';
      return await requestGoBackend('search', { source, query, limit, docKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const source = payload && typeof payload.source === 'string' ? payload.source : '';
        const query = payload && typeof payload.query === 'string' ? payload.query : '';
        const limit = payload && typeof payload.limit === 'number' ? payload.limit : 2000;
        return await searchStructureInWorker(source, query, limit);
      } catch (_fallbackError) {
        return { ok: false, error: `Go search failed: ${message}` };
      }
    }
  });

  ipcMain.handle('build-tree-model-async', async (_event, payload) => {
    try {
      const source = payload && typeof payload.source === 'string' ? payload.source : '';
      const query = payload && typeof payload.query === 'string' ? payload.query : '';
      const expandedPaths = Array.isArray(payload?.expandedPaths) ? payload.expandedPaths : [];
      const defaultExpandDepth = payload && typeof payload.defaultExpandDepth === 'number' ? payload.defaultExpandDepth : 2;
      const docKey = payload && typeof payload.docKey === 'string' ? payload.docKey : '';
      return await requestGoBackend('buildTreeRows', {
        source,
        docKey,
        query,
        expandedPaths,
        defaultExpandDepth
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Go tree model failed: ${message}` };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (goBackendProcess && !goBackendProcess.killed) {
    goBackendProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
