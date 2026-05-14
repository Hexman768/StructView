const { parentPort, workerData } = require('worker_threads');
const YAML = require('yaml');

function parseInput(text) {
  const source = String(text || '').trim();

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

const result = parseInput(workerData && typeof workerData.text === 'string' ? workerData.text : '');
if (parentPort) {
  parentPort.postMessage(result);
}
