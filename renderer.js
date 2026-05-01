const inputBox = document.getElementById('input-box');
const highlightLayer = document.getElementById('highlight-layer');
const treeRoot = document.getElementById('tree-root');
const statusEl = document.getElementById('status');
const renderBtn = document.getElementById('render-btn') || document.getElementById('generate-btn');
const editorWrap = document.getElementById('editor-wrap');
let parseDebounce;

const sample = `project:
  name: StructView
  version: 1.0
  tags:
    - desktop
    - parser
    - viewer
  features:
    syntaxHighlighting: true
    collapsibleNodes: true
    supports:
      - JSON
      - YAML
`;

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightText(text) {
  let html = escapeHtml(text);

  html = html.replace(
    /^([ \t-]*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/gm,
    '$1<span class="token-key">$2</span>$3'
  );

  html = html.replace(
    /(\"(?:\\.|[^\"\\])*\"\s*:)/g,
    '<span class="token-key">$1</span>'
  );

  html = html.replace(
    /(\"(?:\\.|[^\"\\])*\")/g,
    '<span class="token-string">$1</span>'
  );

  html = html.replace(
    /\b(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi,
    '<span class="token-number">$1</span>'
  );

  html = html.replace(/\b(true|false)\b/gi, '<span class="token-bool">$1</span>');
  html = html.replace(/\b(null|~)\b/g, '<span class="token-null">$1</span>');

  html = html.replace(/(^|\s)(#.*)$/gm, '$1<span class="token-comment">$2</span>');

  return html;
}

function setStatus(message, type = 'neutral') {
  statusEl.textContent = message;
  statusEl.classList.remove('error', 'success');

  if (type === 'error') {
    statusEl.classList.add('error');
  }

  if (type === 'success') {
    statusEl.classList.add('success');
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatPrimitive(value) {
  if (typeof value === 'string') {
    return `"${value}"`;
  }

  if (value === null) {
    return 'null';
  }

  return String(value);
}

function nodeType(value) {
  if (Array.isArray(value)) {
    return 'Array';
  }

  if (isObject(value)) {
    return 'Object';
  }

  return 'Value';
}

function createPrimitiveNode(label, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'node primitive-row';

  const content = document.createElement('div');
  content.className = 'primitive';

  const key = document.createElement('span');
  key.className = 'node-key';
  key.textContent = label;

  const type = document.createElement('span');
  type.className = 'node-type';
  type.textContent = nodeType(value);

  const primitiveValue = document.createElement('span');
  primitiveValue.textContent = formatPrimitive(value);

  content.append(key, type, primitiveValue);
  wrapper.appendChild(content);
  return wrapper;
}

function createBranchNode(label, value, depth) {
  const wrapper = document.createElement('div');
  wrapper.className = 'node';

  const details = document.createElement('details');
  details.open = depth < 2;

  const summary = document.createElement('summary');

  const key = document.createElement('span');
  key.className = 'node-key';
  key.textContent = label;

  const type = document.createElement('span');
  type.className = 'node-type';
  type.textContent = nodeType(value);

  const meta = document.createElement('span');
  meta.className = 'node-meta';

  if (Array.isArray(value)) {
    meta.textContent = `${value.length} item${value.length === 1 ? '' : 's'}`;
  } else {
    const size = Object.keys(value).length;
    meta.textContent = `${size} field${size === 1 ? '' : 's'}`;
  }

  summary.append(key, type, meta);
  details.appendChild(summary);

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'node-children';

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      childrenWrap.appendChild(createTreeNode(`[${index}]`, item, depth + 1));
    });
  } else {
    Object.entries(value).forEach(([childKey, childValue]) => {
      childrenWrap.appendChild(createTreeNode(childKey, childValue, depth + 1));
    });
  }

  details.appendChild(childrenWrap);
  wrapper.appendChild(details);
  return wrapper;
}

function createTreeNode(label, value, depth = 0) {
  if (isObject(value) || Array.isArray(value)) {
    return createBranchNode(label, value, depth);
  }

  return createPrimitiveNode(label, value);
}

function renderStructure(data) {
  treeRoot.innerHTML = '';
  treeRoot.appendChild(createTreeNode('root', data, 0));
}

function parseSource(source) {
  const api = window.structViewApi;

  if (api && typeof api.parseInput === 'function') {
    return api.parseInput(source);
  }

  try {
    return {
      ok: true,
      format: 'JSON',
      data: JSON.parse(source),
      fallback: true
    };
  } catch (jsonError) {
    return {
      ok: false,
      error:
        'Parser unavailable in browser preview mode. JSON works here, but YAML needs the Electron app (`npm start`). ' +
        `JSON error: ${jsonError.message}`
    };
  }
}

function parseAndRender() {
  try {
    const source = inputBox.value;
    const parsed = parseSource(source);

    if (!parsed.ok) {
      setStatus(parsed.error, 'error');
      treeRoot.innerHTML = '<p class="node-meta">Structure will appear here after successful parsing.</p>';
      return;
    }

    renderStructure(parsed.data);
    const modeNote = parsed.fallback ? ' (browser preview mode)' : '';
    setStatus(`Parsed as ${parsed.format}${modeNote}. Expand any box to inspect nested values.`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Render failed: ${message}`, 'error');
    treeRoot.innerHTML = '<p class="node-meta">Structure rendering failed. Check input and try again.</p>';
    console.error('StructView render error:', error);
  }
}

function syncHighlight() {
  const text = inputBox.value || '';
  highlightLayer.innerHTML = `${highlightText(text)}\n`;
}

inputBox.addEventListener('input', () => {
  syncHighlight();
  clearTimeout(parseDebounce);
  parseDebounce = setTimeout(parseAndRender, 250);
});

inputBox.addEventListener('scroll', () => {
  highlightLayer.scrollTop = inputBox.scrollTop;
  highlightLayer.scrollLeft = inputBox.scrollLeft;
});

editorWrap.addEventListener('scroll', () => {
  inputBox.scrollTop = editorWrap.scrollTop;
  inputBox.scrollLeft = editorWrap.scrollLeft;
  highlightLayer.scrollTop = editorWrap.scrollTop;
  highlightLayer.scrollLeft = editorWrap.scrollLeft;
});

if (renderBtn) {
  renderBtn.addEventListener('click', parseAndRender);
}

inputBox.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    parseAndRender();
  }
});

inputBox.value = sample;
syncHighlight();
parseAndRender();
