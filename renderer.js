const inputBox = document.getElementById('input-box');
const highlightLayer = document.getElementById('highlight-layer');
const treeRoot = document.getElementById('tree-root');
const statusEl = document.getElementById('status');
const searchInput = document.getElementById('tree-search');
const searchPrevButton = document.getElementById('tree-search-prev');
const searchNextButton = document.getElementById('tree-search-next');
const searchClearButton = document.getElementById('tree-search-clear');
const searchStatus = document.getElementById('search-status');
const renderBtn = document.getElementById('render-btn') || document.getElementById('generate-btn');
const editorWrap = document.getElementById('editor-wrap');
let parseDebounce;
let latestParsedData = null;
let latestMatches = [];
let activeMatchIndex = -1;

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

function containsQuery(query, text) {
  if (!query) {
    return false;
  }

  return String(text).toLowerCase().includes(query);
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

function createPrimitiveNode(label, value, query, matches) {
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
  const primitiveText = formatPrimitive(value);
  primitiveValue.textContent = primitiveText;

  if (query && containsQuery(query, label)) {
    key.classList.add('match-hit');
    matches.push(key);
  }

  if (query && containsQuery(query, primitiveText)) {
    primitiveValue.classList.add('match-hit');
    matches.push(primitiveValue);
  }

  content.append(key, type, primitiveValue);
  wrapper.appendChild(content);
  return wrapper;
}

function createBranchNode(label, value, depth, query, matches) {
  const wrapper = document.createElement('div');
  wrapper.className = 'node';

  const details = document.createElement('details');
  details.open = depth < 2;

  const summary = document.createElement('summary');

  const key = document.createElement('span');
  key.className = 'node-key';
  key.textContent = label;
  const branchMatches = Boolean(query && containsQuery(query, label));

  if (branchMatches) {
    key.classList.add('match-hit');
    matches.push(key);
  }

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
      childrenWrap.appendChild(createTreeNode(`[${index}]`, item, depth + 1, query, matches));
    });
  } else {
    Object.entries(value).forEach(([childKey, childValue]) => {
      childrenWrap.appendChild(createTreeNode(childKey, childValue, depth + 1, query, matches));
    });
  }

  details.appendChild(childrenWrap);
  wrapper.appendChild(details);
  return wrapper;
}

function createTreeNode(label, value, depth = 0, query = '', matches = []) {
  if (isObject(value) || Array.isArray(value)) {
    return createBranchNode(label, value, depth, query, matches);
  }

  return createPrimitiveNode(label, value, query, matches);
}

function clearActiveMatch() {
  treeRoot.querySelectorAll('.active-match').forEach((el) => {
    el.classList.remove('active-match');
  });
}

function openDetailsPathForMatch(matchEl) {
  let current = matchEl.parentElement;
  while (current && current !== treeRoot) {
    if (current.tagName === 'DETAILS') {
      current.open = true;
    }
    current = current.parentElement;
  }
}

function updateMatchButtons() {
  const enabled = latestMatches.length > 0;

  if (searchPrevButton) {
    searchPrevButton.disabled = !enabled;
  }

  if (searchNextButton) {
    searchNextButton.disabled = !enabled;
  }
}

function setActiveMatch(index, query, scroll = true) {
  if (!searchStatus) {
    return;
  }

  if (latestMatches.length === 0) {
    activeMatchIndex = -1;
    searchStatus.textContent = `No matches for "${query}".`;
    return;
  }

  const normalizedIndex = ((index % latestMatches.length) + latestMatches.length) % latestMatches.length;
  activeMatchIndex = normalizedIndex;
  clearActiveMatch();

  const matchEl = latestMatches[activeMatchIndex];
  matchEl.classList.add('active-match');
  openDetailsPathForMatch(matchEl);
  if (scroll) {
    matchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  searchStatus.textContent = `${activeMatchIndex + 1} / ${latestMatches.length} match${
    latestMatches.length === 1 ? '' : 'es'
  } for "${query}".`;
}

function focusFirstMatch(matches, query, focusNextButton = false) {
  clearActiveMatch();
  latestMatches = matches;
  updateMatchButtons();

  if (!searchStatus) {
    return;
  }

  if (!query) {
    activeMatchIndex = -1;
    searchStatus.textContent = 'Showing full structure.';
    return;
  }

  if (matches.length === 0) {
    activeMatchIndex = -1;
    searchStatus.textContent = `No matches for "${query}".`;
    return;
  }

  setActiveMatch(0, query, true);

  if (focusNextButton && searchNextButton && !searchNextButton.disabled) {
    searchNextButton.focus();
  }
}

function renderStructure(data, query = '', jumpToMatch = false, focusNextButton = false) {
  treeRoot.innerHTML = '';

  const normalizedQuery = query.trim().toLowerCase();
  const matches = [];
  const rootNode = createTreeNode('root', data, 0, normalizedQuery, matches);

  treeRoot.appendChild(rootNode);
  if (jumpToMatch) {
    focusFirstMatch(matches, query.trim(), focusNextButton);
  } else if (searchStatus) {
    latestMatches = matches;
    updateMatchButtons();
    activeMatchIndex = matches.length > 0 ? 0 : -1;
    searchStatus.textContent = normalizedQuery
      ? `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query.trim()}".`
      : 'Showing full structure.';
  }
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
      latestParsedData = null;
      setStatus(parsed.error, 'error');
      treeRoot.innerHTML = '<p class="node-meta">Structure will appear here after successful parsing.</p>';
      if (searchStatus) {
        searchStatus.textContent = 'Showing full structure.';
      }
      return;
    }

    latestParsedData = parsed.data;
    const searchValue = searchInput ? searchInput.value : '';
    renderStructure(parsed.data, searchValue, true, Boolean(searchValue.trim()));
    const modeNote = parsed.fallback ? ' (browser preview mode)' : '';
    setStatus(`Parsed as ${parsed.format}${modeNote}. Expand any box to inspect nested values.`, 'success');
  } catch (error) {
    latestParsedData = null;
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Render failed: ${message}`, 'error');
    treeRoot.innerHTML = '<p class="node-meta">Structure rendering failed. Check input and try again.</p>';
    if (searchStatus) {
      searchStatus.textContent = 'Showing full structure.';
    }
    console.error('StructView render error:', error);
  }
}

function syncHighlight() {
  const text = inputBox.value || '';
  highlightLayer.textContent = `${text}\n`;
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

if (searchInput) {
  searchInput.addEventListener('input', () => {
    if (latestParsedData !== null) {
      renderStructure(latestParsedData, searchInput.value, true, false);
    }
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (latestParsedData !== null) {
        renderStructure(latestParsedData, searchInput.value, true, true);
      }
    }
  });
}

if (searchClearButton) {
  searchClearButton.addEventListener('click', () => {
    if (searchInput) {
      searchInput.value = '';
      if (latestParsedData !== null) {
        renderStructure(latestParsedData, '', false);
      }
      searchInput.focus();
    }
  });
}

if (searchPrevButton) {
  searchPrevButton.addEventListener('click', () => {
    if (latestMatches.length > 0 && searchInput) {
      setActiveMatch(activeMatchIndex - 1, searchInput.value.trim(), true);
    }
  });
}

if (searchNextButton) {
  searchNextButton.addEventListener('click', () => {
    if (latestMatches.length > 0 && searchInput) {
      setActiveMatch(activeMatchIndex + 1, searchInput.value.trim(), true);
    }
  });
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
