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
    (() => {
      const json = ${JSON.stringify(JSON.stringify(exampleJson, null, 2))};
      const input = document.getElementById('input-box');
      const renderBtn = document.getElementById('render-btn') || document.getElementById('generate-btn');
      if (input) {
        input.value = json;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
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
