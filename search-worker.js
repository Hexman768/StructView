const { parentPort, workerData } = require('worker_threads');
const YAML = require('yaml');

function parseSource(source) {
  const text = String(source || '').trim();
  if (!text) {
    return {
      ok: false,
      error: 'Paste JSON or YAML to begin.'
    };
  }

  try {
    return {
      ok: true,
      data: JSON.parse(text)
    };
  } catch (jsonError) {
    try {
      return {
        ok: true,
        data: YAML.parse(text)
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function primitiveText(value) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

function searchPaths(root, query, limit) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const results = [];
  const seen = new Set();
  const stack = [{ value: root, path: [] }];

  while (stack.length > 0 && results.length < limit) {
    const current = stack.pop();
    const value = current.value;
    const path = current.path;

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) {
        stack.push({
          value: value[i],
          path: [...path, i]
        });
      }
      continue;
    }

    if (isObject(value)) {
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [key, child] = entries[i];
        const childPath = [...path, key];
        if (String(key).toLowerCase().includes(normalized)) {
          const token = JSON.stringify(childPath);
          if (!seen.has(token)) {
            seen.add(token);
            results.push({
              path: childPath,
              target: 'key'
            });
            if (results.length >= limit) {
              break;
            }
          }
        }
        stack.push({
          value: child,
          path: childPath
        });
      }
      continue;
    }

    if (primitiveText(value).toLowerCase().includes(normalized)) {
      const token = JSON.stringify(path);
      if (!seen.has(token)) {
        seen.add(token);
        results.push({
          path,
          target: 'value'
        });
      }
    }
  }

  return results;
}

const source = workerData && typeof workerData.source === 'string' ? workerData.source : '';
const query = workerData && typeof workerData.query === 'string' ? workerData.query : '';
const limit = workerData && typeof workerData.limit === 'number' ? workerData.limit : 2000;

const parsed = parseSource(source);
if (!parsed.ok) {
  parentPort.postMessage(parsed);
} else {
  const results = searchPaths(parsed.data, query, limit);
  parentPort.postMessage({
    ok: true,
    query,
    count: results.length,
    results
  });
}
