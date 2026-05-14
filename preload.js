const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const settingsPath = path.join(__dirname, 'settings.json');

function getSettings() {
  const defaults = {
    startWithEmptyInput: true,
    defaultInput: ''
  };

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaults,
      ...parsed
    };
  } catch (error) {
    return defaults;
  }
}

function parseInput(text) {
  const source = (text || '').trim();

  if (!source) {
    return {
      ok: false,
      error: 'Paste JSON or YAML to begin.'
    };
  }

  try {
    return {
      ok: true,
      format: 'JSON',
      data: JSON.parse(source)
    };
  } catch (jsonError) {
    try {
      return {
        ok: true,
        format: 'YAML',
        data: YAML.parse(source)
      };
    } catch (yamlError) {
      const yamlMessage = yamlError instanceof Error ? yamlError.message : String(yamlError);
      return {
        ok: false,
        error: `Unable to parse input as JSON or YAML. JSON error: ${jsonError.message}. YAML error: ${yamlMessage}`
      };
    }
  }
}

function stringifyYaml(value) {
  return YAML.stringify(value);
}

contextBridge.exposeInMainWorld('structViewApi', {
  parseInput,
  parseInputAsync: (text) => ipcRenderer.invoke('parse-input-async', text || ''),
  getSettings,
  stringifyYaml,
  onOpenFile: (handler) => {
    if (typeof handler !== 'function') {
      return () => {};
    }

    const listener = (_event, payload) => {
      handler(payload);
    };

    ipcRenderer.on('menu-open-file', listener);
    return () => {
      ipcRenderer.removeListener('menu-open-file', listener);
    };
  },
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveFileDialog: (request) => ipcRenderer.invoke('save-file-dialog', request || {}),
  onRequestSave: (handler) => {
    if (typeof handler !== 'function') {
      return () => {};
    }

    const listener = () => {
      handler();
    };

    ipcRenderer.on('menu-save-file-request', listener);
    return () => {
      ipcRenderer.removeListener('menu-save-file-request', listener);
    };
  }
});
