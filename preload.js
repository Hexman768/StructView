const { contextBridge } = require('electron');
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

contextBridge.exposeInMainWorld('structViewApi', {
  parseInput,
  getSettings
});
