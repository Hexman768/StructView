const tabsBar = document.getElementById('tabs-bar');
const addTabButton = document.getElementById('add-tab-btn');
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
let nextTabId = 1;
const tabs = [];
let activeTabId = null;

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

function currentTab() {
  return tabs.find((tab) => tab.id === activeTabId) || null;
}

function makeTabState(initialInput = '') {
  const id = nextTabId;
  nextTabId += 1;

  return {
    id,
    title: `Tab ${id}`,
    input: initialInput,
    parsedData: null,
    search: '',
    matches: [],
    activeMatchIndex: -1,
    statusText: 'Waiting for input...',
    statusType: 'neutral'
  };
}

function setStatus(message, type = 'neutral') {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  tab.statusText = message;
  tab.statusType = type;

  statusEl.textContent = message;
  statusEl.classList.remove('error', 'success');
  if (type === 'error') {
    statusEl.classList.add('error');
  }
  if (type === 'success') {
    statusEl.classList.add('success');
  }
}

function refreshStatusFromTab() {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  statusEl.textContent = tab.statusText;
  statusEl.classList.remove('error', 'success');
  if (tab.statusType === 'error') {
    statusEl.classList.add('error');
  }
  if (tab.statusType === 'success') {
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

  if (query && containsQuery(query, label)) {
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
  const tab = currentTab();
  const enabled = Boolean(tab && tab.matches.length > 0);

  if (searchPrevButton) {
    searchPrevButton.disabled = !enabled;
  }
  if (searchNextButton) {
    searchNextButton.disabled = !enabled;
  }
}

function setActiveMatch(index, query, scroll = true) {
  const tab = currentTab();
  if (!tab || !searchStatus) {
    return;
  }

  if (tab.matches.length === 0) {
    tab.activeMatchIndex = -1;
    searchStatus.textContent = `No matches for "${query}".`;
    updateMatchButtons();
    return;
  }

  const normalizedIndex = ((index % tab.matches.length) + tab.matches.length) % tab.matches.length;
  tab.activeMatchIndex = normalizedIndex;

  clearActiveMatch();
  const matchEl = tab.matches[normalizedIndex];
  matchEl.classList.add('active-match');
  openDetailsPathForMatch(matchEl);

  if (scroll) {
    matchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  searchStatus.textContent = `${tab.activeMatchIndex + 1} / ${tab.matches.length} match${
    tab.matches.length === 1 ? '' : 'es'
  } for "${query}".`;
  updateMatchButtons();
}

function renderStructure(data, query = '', jumpToMatch = false, focusNextButton = false) {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  treeRoot.innerHTML = '';

  const normalizedQuery = query.trim().toLowerCase();
  const matches = [];
  const rootNode = createTreeNode('root', data, 0, normalizedQuery, matches);
  treeRoot.appendChild(rootNode);

  tab.matches = matches;

  if (!normalizedQuery) {
    clearActiveMatch();
    tab.activeMatchIndex = -1;
    if (searchStatus) {
      searchStatus.textContent = 'Showing full structure.';
    }
    updateMatchButtons();
    return;
  }

  if (jumpToMatch) {
    setActiveMatch(0, query.trim(), true);
    if (focusNextButton && searchNextButton && !searchNextButton.disabled) {
      searchNextButton.focus();
    }
  } else if (searchStatus) {
    searchStatus.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query.trim()}".`;
    updateMatchButtons();
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

function parseAndRender(focusNextButton = false) {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  try {
    const source = tab.input;
    const parsed = parseSource(source);

    if (!parsed.ok) {
      tab.parsedData = null;
      tab.matches = [];
      tab.activeMatchIndex = -1;
      setStatus(parsed.error, 'error');
      treeRoot.innerHTML = '<p class="node-meta">Structure will appear here after successful parsing.</p>';
      if (searchStatus) {
        searchStatus.textContent = 'Showing full structure.';
      }
      updateMatchButtons();
      return;
    }

    tab.parsedData = parsed.data;
    renderStructure(parsed.data, tab.search, true, focusNextButton && Boolean(tab.search.trim()));
    const modeNote = parsed.fallback ? ' (browser preview mode)' : '';
    setStatus(`Parsed as ${parsed.format}${modeNote}. Expand any box to inspect nested values.`, 'success');
  } catch (error) {
    tab.parsedData = null;
    tab.matches = [];
    tab.activeMatchIndex = -1;
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Render failed: ${message}`, 'error');
    treeRoot.innerHTML = '<p class="node-meta">Structure rendering failed. Check input and try again.</p>';
    if (searchStatus) {
      searchStatus.textContent = 'Showing full structure.';
    }
    updateMatchButtons();
    console.error('StructView render error:', error);
  }
}

function syncHighlight() {
  const tab = currentTab();
  const text = tab ? tab.input : '';
  highlightLayer.textContent = `${text}\n`;
}

function renderTabBar() {
  if (!tabsBar) {
    return;
  }

  tabsBar.innerHTML = '';

  tabs.forEach((tab) => {
    const tabButton = document.createElement('button');
    tabButton.type = 'button';
    tabButton.className = `tab-btn${tab.id === activeTabId ? ' active' : ''}`;
    tabButton.dataset.tabId = String(tab.id);

    const label = document.createElement('span');
    label.textContent = tab.title;

    tabButton.appendChild(label);

    if (tabs.length > 1) {
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'tab-close';
      closeButton.textContent = 'x';
      closeButton.title = `Close ${tab.title}`;
      closeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });
      tabButton.appendChild(closeButton);
    }

    tabButton.addEventListener('click', () => {
      switchTab(tab.id);
    });

    tabsBar.appendChild(tabButton);
  });
}

function hydrateActiveTab() {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  inputBox.value = tab.input;
  if (searchInput) {
    searchInput.value = tab.search;
  }

  syncHighlight();
  refreshStatusFromTab();

  if (tab.parsedData !== null) {
    renderStructure(tab.parsedData, tab.search, false, false);
    if (tab.search.trim() && tab.matches.length > 0) {
      setActiveMatch(tab.activeMatchIndex >= 0 ? tab.activeMatchIndex : 0, tab.search.trim(), false);
    }
  } else {
    treeRoot.innerHTML = '<p class="node-meta">Structure will appear here after successful parsing.</p>';
    if (searchStatus) {
      searchStatus.textContent = tab.search.trim() ? `No matches for "${tab.search.trim()}".` : 'Showing full structure.';
    }
    updateMatchButtons();
  }
}

function switchTab(id) {
  activeTabId = id;
  renderTabBar();
  hydrateActiveTab();
}

function addTab(initialInput = '') {
  const tab = makeTabState(initialInput);
  tabs.push(tab);
  switchTab(tab.id);
}

function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) {
    return;
  }

  tabs.splice(index, 1);

  if (tabs.length === 0) {
    addTab(sample);
    return;
  }

  if (activeTabId === id) {
    const fallbackIndex = Math.max(0, index - 1);
    activeTabId = tabs[fallbackIndex].id;
  }

  renderTabBar();
  hydrateActiveTab();
}

inputBox.addEventListener('input', () => {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  tab.input = inputBox.value;
  syncHighlight();

  clearTimeout(parseDebounce);
  parseDebounce = setTimeout(() => parseAndRender(false), 250);
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
  renderBtn.addEventListener('click', () => parseAndRender(true));
}

if (searchInput) {
  searchInput.addEventListener('input', () => {
    const tab = currentTab();
    if (!tab) {
      return;
    }

    tab.search = searchInput.value;
    if (tab.parsedData !== null) {
      renderStructure(tab.parsedData, tab.search, true, false);
    }
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const tab = currentTab();
      if (tab && tab.parsedData !== null) {
        renderStructure(tab.parsedData, tab.search, true, true);
      }
    }
  });
}

if (searchClearButton) {
  searchClearButton.addEventListener('click', () => {
    const tab = currentTab();
    if (!tab || !searchInput) {
      return;
    }

    tab.search = '';
    searchInput.value = '';

    if (tab.parsedData !== null) {
      renderStructure(tab.parsedData, '', false, false);
    }

    searchInput.focus();
  });
}

if (searchPrevButton) {
  searchPrevButton.addEventListener('click', () => {
    const tab = currentTab();
    if (tab && tab.matches.length > 0) {
      setActiveMatch(tab.activeMatchIndex - 1, tab.search.trim(), true);
    }
  });
}

if (searchNextButton) {
  searchNextButton.addEventListener('click', () => {
    const tab = currentTab();
    if (tab && tab.matches.length > 0) {
      setActiveMatch(tab.activeMatchIndex + 1, tab.search.trim(), true);
    }
  });
}

inputBox.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    parseAndRender(true);
  }
});

if (addTabButton) {
  addTabButton.addEventListener('click', () => {
    addTab('');
  });
}

addTab(sample);
parseAndRender(false);
