const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const outputPath = path.join(__dirname, '..', 'assets', 'structview-screenshot.png');

const exampleJson = {
  projectId: 'demo-project-42',
  title: 'Mock Smart Home Setup',
  meta: {
    versionId: '1.0.0-mock',
    lastUpdated: '2026-05-01T10:30:00Z',
    environment: 'demo'
  },
  owner: {
    name: 'Avery Example',
    team: 'Product Sandbox'
  },
  devices: [
    {
      id: 'sensor-temp-living',
      type: 'temperatureSensor',
      room: 'Living Room',
      batteryPercent: 86,
      active: true
    },
    {
      id: 'light-kitchen-main',
      type: 'smartLight',
      room: 'Kitchen',
      brightness: 72,
      colorMode: 'warm'
    }
  ],
  automations: [
    {
      id: 'auto-evening-lights',
      trigger: 'sunset',
      actions: ['light-kitchen-main:on', 'light-entry:on']
    },
    {
      id: 'auto-away-mode',
      trigger: 'geofence_exit',
      actions: ['thermostat:setEco', 'lights:off']
    }
  ],
  tags: ['mock-data', 'example', 'documentation'],
  notes: null
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createScreenshot() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#071019',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const indexPath = path.join(__dirname, '..', 'index.html');
  await win.loadFile(indexPath);

  await win.webContents.executeJavaScript(`
    (async () => {
      const json = ${JSON.stringify(JSON.stringify(exampleJson, null, 2))};
      const { EditorView } = await import('@codemirror/view');
      const editor = document.querySelector('.cm-editor');
      const editorView = editor ? EditorView.findFromDOM(editor) : null;
      if (editorView) {
        editorView.dispatch({
          changes: { from: 0, to: editorView.state.doc.length, insert: json }
        });
      }
      const renderBtn = document.getElementById('render-btn') || document.getElementById('generate-btn');
      if (renderBtn) {
        renderBtn.click();
      }
    })();
  `);

  await wait(500);

  const image = await win.webContents.capturePage();
  fs.writeFileSync(outputPath, image.toPNG());
  await win.destroy();
}

app.whenReady()
  .then(createScreenshot)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
