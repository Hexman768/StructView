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
const openFileButton = document.getElementById('open-file-btn');
const saveFileButton = document.getElementById('save-file-btn');
const clearTextButton = document.getElementById('clear-text-btn');
const showTextPaneButton = document.getElementById('show-text-pane-btn');
const bodyEl = document.body;
const LARGE_FILE_HIDE_INPUT_LINE_THRESHOLD = 10000;

let parseDebounce;
let nextTabId = 1;
const tabs = [];
let activeTabId = null;
let dragState = null;

function loadAppSettings() {
  const defaults = {
    startWithEmptyInput: true,
    defaultInput: ''
  };

  const api = window.structViewApi;
  if (!api || typeof api.getSettings !== 'function') {
    return defaults;
  }

  const settings = api.getSettings();
  return {
    ...defaults,
    ...settings
  };
}

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
    statusType: 'neutral',
    parsedFormat: 'JSON',
    parseFallback: false,
    expandedPaths: new Set(),
    sourceFilePath: null,
    sourceFileName: null,
    savedInputSnapshot: initialInput,
    dirty: false,
    hideEditorForLargeFile: false,
    showEditorOverride: false
  };
}

function countLines(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }

  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }
  return lines;
}

function shouldHideEditor(tab) {
  return Boolean(tab && tab.hideEditorForLargeFile && !tab.showEditorOverride);
}

function applyPaneVisibility(tab = currentTab()) {
  const hideEditor = shouldHideEditor(tab);
  bodyEl.classList.toggle('structure-only-mode', hideEditor);
  if (showTextPaneButton) {
    showTextPaneButton.hidden = !hideEditor;
  }
}

function refreshDirtyState(tab) {
  if (!tab) {
    return;
  }
  tab.dirty = tab.input !== (tab.savedInputSnapshot || '');
}

function updateSaveButton(tab = currentTab()) {
  if (!saveFileButton) {
    return;
  }
  saveFileButton.hidden = !(tab && tab.dirty);
}

function defaultSaveNameForTab(tab) {
  if (!tab) {
    return 'structview-data.json';
  }
  if (tab.sourceFileName) {
    return tab.sourceFileName;
  }

  const base = (tab.title || 'structview-data')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\\s+/g, ' ')
    .trim();
  const ext = tab.parsedFormat === 'YAML' ? 'yaml' : 'json';
  return `${base || 'structview-data'}.${ext}`;
}

async function saveCurrentTab() {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  const api = window.structViewApi;
  if (!api || typeof api.saveFileDialog !== 'function') {
    setStatus('Save is only available in the desktop app.', 'error');
    return;
  }

  try {
    const result = await api.saveFileDialog({
      content: tab.input,
      filePath: tab.sourceFilePath || '',
      fileName: defaultSaveNameForTab(tab)
    });

    if (!result || result.canceled) {
      return;
    }
    if (!result.ok) {
      setStatus(`Save failed: ${result.error || 'Unknown error.'}`, 'error');
      return;
    }

    tab.sourceFilePath = result.filePath || tab.sourceFilePath;
    tab.sourceFileName = result.fileName || tab.sourceFileName;
    if (tab.sourceFileName) {
      tab.title = tab.sourceFileName;
      renderTabBar();
    }
    tab.savedInputSnapshot = tab.input;
    refreshDirtyState(tab);
    updateSaveButton(tab);
    setStatus('File saved successfully.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Save failed: ${message}`, 'error');
  }
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

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightInput(text) {
  const escaped = escapeHtml(text);
  const tokenPattern =
    /"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?|#[^\n]*/g;

  return escaped.replace(tokenPattern, (match, offset, fullText) => {
    if (match.startsWith('"')) {
      let cursor = offset + match.length;
      while (cursor < fullText.length && /\s/.test(fullText[cursor])) {
        cursor += 1;
      }
      const className = fullText[cursor] === ':' ? 'token-key' : 'token-string';
      return `<span class="${className}">${match}</span>`;
    }

    if (match === 'true' || match === 'false') {
      return `<span class="token-bool">${match}</span>`;
    }

    if (match === 'null') {
      return `<span class="token-null">${match}</span>`;
    }

    if (match.startsWith('#')) {
      return `<span class="token-comment">${match}</span>`;
    }

    return `<span class="token-number">${match}</span>`;
  });
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

function getArrayItemLabel(item) {
  if (isObject(item)) {
    const keys = Object.keys(item);
    if (keys.length === 1) {
      return keys[0];
    }

    const preferredKeys = ['name', 'id', 'title', 'label', 'key', 'dtaName'];
    for (const preferredKey of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(item, preferredKey)) {
        const preferredValue = item[preferredKey];
        if (preferredValue !== null && typeof preferredValue !== 'object') {
          return `${preferredKey}: ${String(preferredValue)}`;
        }
      }
    }
  }

  if (typeof item === 'string') {
    return item.length > 26 ? `${item.slice(0, 26)}...` : item;
  }

  return 'item';
}

function captureExpandedPaths() {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  const next = new Set();
  treeRoot.querySelectorAll('details[data-node-path]').forEach((details) => {
    if (details.open) {
      next.add(details.dataset.nodePath);
    }
  });
  tab.expandedPaths = next;
}

function encodePath(path) {
  return JSON.stringify(path);
}

function decodePath(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function getNodeAtPath(root, path) {
  let node = root;
  for (const segment of path) {
    if (node === undefined || node === null) {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

function setNodeAtPath(root, path, value) {
  if (path.length === 0) {
    return value;
  }

  const parentPath = path.slice(0, -1);
  const parent = getNodeAtPath(root, parentPath);
  const key = path[path.length - 1];

  if (Array.isArray(parent)) {
    parent[Number(key)] = value;
  } else if (isObject(parent)) {
    parent[key] = value;
  }

  return root;
}

function removeNodeAtPath(root, path) {
  if (path.length === 0) {
    return null;
  }

  const parentPath = path.slice(0, -1);
  const parent = getNodeAtPath(root, parentPath);
  const key = path[path.length - 1];

  if (Array.isArray(parent)) {
    const index = Number(key);
    const [value] = parent.splice(index, 1);
    return {
      key: index,
      value,
      parentType: 'array'
    };
  }

  if (isObject(parent)) {
    const value = parent[key];
    delete parent[key];
    return {
      key,
      value,
      parentType: 'object'
    };
  }

  return null;
}

function isAncestorPath(ancestorPath, descendantPath) {
  if (ancestorPath.length >= descendantPath.length) {
    return false;
  }

  return ancestorPath.every((segment, index) => segment === descendantPath[index]);
}

function pathsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((segment, index) => segment === right[index]);
}

function makeUniqueKey(targetObject, baseKey) {
  let candidate = baseKey && String(baseKey).trim() ? String(baseKey) : 'movedItem';
  if (!(candidate in targetObject)) {
    return candidate;
  }

  let suffix = 1;
  while (`${candidate}_${suffix}` in targetObject) {
    suffix += 1;
  }
  return `${candidate}_${suffix}`;
}

function canRenamePath(path) {
  if (!path || path.length === 0) {
    return false;
  }
  const tab = currentTab();
  if (!tab || tab.parsedData === null) {
    return false;
  }
  const parent = getNodeAtPath(tab.parsedData, path.slice(0, -1));
  return isObject(parent);
}

function parseEditableValue(rawInput) {
  const raw = rawInput.trim();

  if (!raw) {
    return '';
  }

  const looksLikeJsonLiteral =
    raw === 'null' ||
    raw === 'true' ||
    raw === 'false' ||
    /^-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?$/.test(raw) ||
    raw.startsWith('{') ||
    raw.startsWith('[') ||
    raw.startsWith('"');

  if (looksLikeJsonLiteral) {
    return JSON.parse(raw);
  }

  return rawInput;
}

function serializeParsedData(tab) {
  const api = window.structViewApi;
  if (tab.parsedFormat === 'YAML' && api && typeof api.stringifyYaml === 'function') {
    return api.stringifyYaml(tab.parsedData);
  }

  return JSON.stringify(tab.parsedData, null, 2);
}

function refreshTextPaneFromTab(tab) {
  tab.input = serializeParsedData(tab);
  refreshDirtyState(tab);
  inputBox.value = tab.input;
  updateSaveButton(tab);
  syncHighlight();
}

function applyStructureChange(message) {
  const tab = currentTab();
  if (!tab || tab.parsedData === null) {
    return;
  }

  refreshTextPaneFromTab(tab);
  renderStructure(tab.parsedData, tab.search, false, false);
  if (tab.search.trim() && tab.matches.length > 0) {
    setActiveMatch(tab.activeMatchIndex >= 0 ? tab.activeMatchIndex : 0, tab.search.trim(), false);
  }
  setStatus(message, 'success');
}

function renamePathKeyIfNeeded(path, nextKeyRaw) {
  const tab = currentTab();
  if (!tab || tab.parsedData === null) {
    return path;
  }

  if (!canRenamePath(path)) {
    return path;
  }

  const trimmed = String(nextKeyRaw ?? '').trim();
  const oldKey = path[path.length - 1];
  const newKey = trimmed || String(oldKey);
  if (String(oldKey) === newKey) {
    return path;
  }

  const parentPath = path.slice(0, -1);
  const parent = getNodeAtPath(tab.parsedData, parentPath);
  if (!isObject(parent)) {
    return path;
  }

  if (Object.prototype.hasOwnProperty.call(parent, newKey)) {
    throw new Error(`Key "${newKey}" already exists in this object.`);
  }
  const entries = Object.entries(parent);
  const index = entries.findIndex(([key]) => key === oldKey);
  if (index < 0) {
    return path;
  }
  const existingValue = entries[index][1];
  entries[index] = [newKey, existingValue];

  Object.keys(parent).forEach((key) => {
    delete parent[key];
  });
  entries.forEach(([key, entryValue]) => {
    parent[key] = entryValue;
  });

  const nextPath = [...path];
  nextPath[nextPath.length - 1] = newKey;
  return nextPath;
}

function createPrimitiveNode(label, value, query, matches, path, indexMeta = '') {
  const wrapper = document.createElement('div');
  wrapper.className = 'node primitive-row';
  wrapper.dataset.nodePath = encodePath(path);

  const content = document.createElement('div');
  content.className = 'primitive';

  if (path.length > 0) {
    const dragHandle = document.createElement('span');
    dragHandle.className = 'node-drag-handle';
    dragHandle.textContent = '::';
    dragHandle.draggable = true;
    dragHandle.dataset.dragSourcePath = encodePath(path);
    dragHandle.title = 'Drag to move this node';
    content.appendChild(dragHandle);
  }

  const key = document.createElement('span');
  key.className = 'node-key';
  key.textContent = label;

  if (indexMeta) {
    const indexBadge = document.createElement('span');
    indexBadge.className = 'node-meta';
    indexBadge.textContent = indexMeta;
    content.appendChild(indexBadge);
  }

  const type = document.createElement('span');
  type.className = 'node-type';
  type.textContent = nodeType(value);

  const primitiveValue = document.createElement('span');
  primitiveValue.className = 'primitive-value';
  const primitiveText = formatPrimitive(value);
  primitiveValue.textContent = primitiveText;

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'node-edit-btn';
  editButton.textContent = 'Edit';
  editButton.dataset.editPath = encodePath(path);
  editButton.draggable = false;
  editButton.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });
  editButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    editor.classList.toggle('visible');
    if (editor.classList.contains('visible')) {
      valueInput.focus();
      valueInput.select();
    }
  });

  const editor = document.createElement('div');
  editor.className = 'node-inline-editor';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.className = 'node-inline-input node-inline-key';
  keyInput.value = label;
  keyInput.disabled = !canRenamePath(path);

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.className = 'node-inline-input node-inline-value';
  valueInput.value = typeof value === 'string' ? value : JSON.stringify(value);

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'node-inline-save';
  saveButton.textContent = 'Save';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'node-inline-cancel';
  cancelButton.textContent = 'Cancel';

  saveButton.addEventListener('click', () => {
    const tab = currentTab();
    if (!tab || tab.parsedData === null) {
      return;
    }
    try {
      const nextPath = renamePathKeyIfNeeded(path, keyInput.value);
      const parsedValue = parseEditableValue(valueInput.value);
      tab.parsedData = setNodeAtPath(tab.parsedData, nextPath, parsedValue);
      applyStructureChange('Updated element from Structure View.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Edit failed: ${message}`, 'error');
    }
  });

  cancelButton.addEventListener('click', () => {
    editor.classList.remove('visible');
  });

  editor.append(keyInput, valueInput, saveButton, cancelButton);

  if (query && containsQuery(query, label)) {
    key.classList.add('match-hit');
    matches.push(key);
  }

  if (query && containsQuery(query, primitiveText)) {
    primitiveValue.classList.add('match-hit');
    matches.push(primitiveValue);
  }

  content.append(key, type, primitiveValue, editButton);
  wrapper.appendChild(content);
  wrapper.appendChild(editor);
  return wrapper;
}

function createBranchNode(label, value, depth, query, matches, path, indexMeta = '') {
  const wrapper = document.createElement('div');
  wrapper.className = 'node';
  wrapper.dataset.nodePath = encodePath(path);

  const details = document.createElement('details');
  const pathToken = encodePath(path);
  details.dataset.nodePath = pathToken;
  const tab = currentTab();
  details.open = Boolean(tab && tab.expandedPaths && tab.expandedPaths.has(pathToken)) || depth < 2;

  const summary = document.createElement('summary');
  summary.className = 'node-summary';
  summary.dataset.dropTargetPath = pathToken;

  if (path.length > 0) {
    const dragHandle = document.createElement('span');
    dragHandle.className = 'node-drag-handle';
    dragHandle.textContent = '::';
    dragHandle.draggable = true;
    dragHandle.dataset.dragSourcePath = pathToken;
    dragHandle.title = 'Drag to move this node';
    summary.appendChild(dragHandle);
  }

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
    const countText = `${value.length} item${value.length === 1 ? '' : 's'}`;
    meta.textContent = indexMeta ? `${indexMeta} • ${countText}` : countText;
  } else {
    const size = Object.keys(value).length;
    const sizeText = `${size} field${size === 1 ? '' : 's'}`;
    meta.textContent = indexMeta ? `${indexMeta} • ${sizeText}` : sizeText;
  }

  const branchEdit = document.createElement('button');
  branchEdit.type = 'button';
  branchEdit.className = 'node-edit-btn';
  branchEdit.textContent = 'Edit';
  branchEdit.draggable = false;

  const branchEditor = document.createElement('div');
  branchEditor.className = 'node-inline-editor';

  const branchKeyInput = document.createElement('input');
  branchKeyInput.type = 'text';
  branchKeyInput.className = 'node-inline-input node-inline-key';
  branchKeyInput.value = label;
  branchKeyInput.disabled = !canRenamePath(path);

  const branchSave = document.createElement('button');
  branchSave.type = 'button';
  branchSave.className = 'node-inline-save';
  branchSave.textContent = 'Save';

  const branchCancel = document.createElement('button');
  branchCancel.type = 'button';
  branchCancel.className = 'node-inline-cancel';
  branchCancel.textContent = 'Cancel';

  branchEdit.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    details.open = true;
    branchEditor.classList.add('visible');
    branchKeyInput.focus();
    branchKeyInput.select();
  });

  branchSave.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const tab = currentTab();
      if (!tab || tab.parsedData === null) {
        return;
      }
      renamePathKeyIfNeeded(path, branchKeyInput.value);
      applyStructureChange('Renamed element from Structure View.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Rename failed: ${message}`, 'error');
    }
  });

  branchCancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    branchEditor.classList.remove('visible');
  });

  branchEditor.append(branchKeyInput, branchSave, branchCancel);

  summary.append(key, type, meta, branchEdit);
  details.appendChild(summary);
  details.appendChild(branchEditor);

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'node-children';
  childrenWrap.dataset.dropTargetPath = pathToken;

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const itemLabel = getArrayItemLabel(item);
      childrenWrap.appendChild(
        createTreeNode(itemLabel, item, depth + 1, query, matches, [...path, index], `index ${index}`)
      );
    });
  } else {
    Object.entries(value).forEach(([childKey, childValue]) => {
      childrenWrap.appendChild(createTreeNode(childKey, childValue, depth + 1, query, matches, [...path, childKey]));
    });
  }

  details.appendChild(childrenWrap);
  wrapper.appendChild(details);
  return wrapper;
}

function createTreeNode(label, value, depth = 0, query = '', matches = [], path = [], indexMeta = '') {
  if (isObject(value) || Array.isArray(value)) {
    return createBranchNode(label, value, depth, query, matches, path, indexMeta);
  }

  return createPrimitiveNode(label, value, query, matches, path, indexMeta);
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

  captureExpandedPaths();
  treeRoot.innerHTML = '';

  const normalizedQuery = query.trim().toLowerCase();
  const matches = [];
  const rootNode = createTreeNode('root', data, 0, normalizedQuery, matches, []);
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
      tab.hideEditorForLargeFile = false;
      tab.showEditorOverride = false;
      tab.matches = [];
      tab.activeMatchIndex = -1;
      setStatus(parsed.error, 'error');
      treeRoot.innerHTML = '<p class="node-meta">Structure will appear here after successful parsing.</p>';
      if (searchStatus) {
        searchStatus.textContent = 'Showing full structure.';
      }
      updateMatchButtons();
      applyPaneVisibility(tab);
      return;
    }

    tab.parsedData = parsed.data;
    tab.parsedFormat = parsed.format;
    tab.parseFallback = Boolean(parsed.fallback);
    tab.hideEditorForLargeFile = countLines(source) >= LARGE_FILE_HIDE_INPUT_LINE_THRESHOLD;
    tab.showEditorOverride = false;
    renderStructure(parsed.data, tab.search, true, focusNextButton && Boolean(tab.search.trim()));
    setStatus(`Parsed as ${parsed.format}. Expand any box to inspect nested values.`, 'success');
    applyPaneVisibility(tab);
  } catch (error) {
    tab.parsedData = null;
    tab.hideEditorForLargeFile = false;
    tab.showEditorOverride = false;
    tab.matches = [];
    tab.activeMatchIndex = -1;
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Render failed: ${message}`, 'error');
    treeRoot.innerHTML = '<p class="node-meta">Structure rendering failed. Check input and try again.</p>';
    if (searchStatus) {
      searchStatus.textContent = 'Showing full structure.';
    }
    updateMatchButtons();
    applyPaneVisibility(tab);
    console.error('StructView render error:', error);
  }
}

function loadOpenedFile(payload) {
  const activeTab = currentTab();
  if (!activeTab || !payload || typeof payload.content !== 'string') {
    return;
  }

  const activeHasContent = Boolean(activeTab.input && activeTab.input.trim()) || activeTab.parsedData !== null;
  const tab = activeHasContent ? addTab('') : activeTab;

  clearTimeout(parseDebounce);
  tab.input = payload.content;
  tab.search = '';
  tab.matches = [];
  tab.activeMatchIndex = -1;
  tab.expandedPaths = new Set();
  tab.hideEditorForLargeFile = false;
  tab.showEditorOverride = false;
  tab.sourceFilePath = typeof payload.filePath === 'string' && payload.filePath ? payload.filePath : null;
  tab.sourceFileName = typeof payload.fileName === 'string' && payload.fileName ? payload.fileName : null;
  tab.savedInputSnapshot = tab.input;
  refreshDirtyState(tab);

  if (typeof payload.fileName === 'string' && payload.fileName.trim()) {
    tab.title = payload.fileName.trim();
    renderTabBar();
  }

  inputBox.value = tab.input;
  if (searchInput) {
    searchInput.value = '';
  }
  syncHighlight();
  applyPaneVisibility(tab);
  updateSaveButton(tab);
  parseAndRender(false);
}

function syncHighlight() {
  const tab = currentTab();
  const text = tab ? tab.input : '';
  highlightLayer.innerHTML = `${highlightInput(text)}\n`;
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

  applyPaneVisibility(tab);
  refreshDirtyState(tab);
  updateSaveButton(tab);
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
  return tab;
}

function closeTab(id) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) {
    return;
  }

  tabs.splice(index, 1);

  if (tabs.length === 0) {
    addTab('');
    return;
  }

  if (activeTabId === id) {
    const fallbackIndex = Math.max(0, index - 1);
    activeTabId = tabs[fallbackIndex].id;
  }

  renderTabBar();
  hydrateActiveTab();
}

function handleEditClick(event) {
  const button = event.target.closest('.node-edit-btn');
  if (!button) {
    return;
  }
}

function clearDropHighlights() {
  treeRoot.querySelectorAll('.drop-target-active').forEach((el) => {
    el.classList.remove('drop-target-active');
  });
}

function applyMove(sourcePath, targetPath) {
  const tab = currentTab();
  if (!tab || tab.parsedData === null) {
    return;
  }

  if (sourcePath.length === 0) {
    setStatus('Root node cannot be moved.', 'error');
    return;
  }

  const sourceParentPath = sourcePath.slice(0, -1);
  if (pathsEqual(sourcePath, targetPath) || pathsEqual(sourceParentPath, targetPath)) {
    return;
  }

  if (isAncestorPath(sourcePath, targetPath)) {
    setStatus('Cannot move a node into its own descendant.', 'error');
    return;
  }

  const targetNode = getNodeAtPath(tab.parsedData, targetPath);
  if (!Array.isArray(targetNode) && !isObject(targetNode)) {
    setStatus('Drop target must be an object or array.', 'error');
    return;
  }

  const sourceParent = getNodeAtPath(tab.parsedData, sourceParentPath);
  const sourceKey = sourcePath[sourcePath.length - 1];
  const sourceParentType = Array.isArray(sourceParent) ? 'array' : isObject(sourceParent) ? 'object' : null;
  const sourceValue = getNodeAtPath(tab.parsedData, sourcePath);

  if (!sourceParentType) {
    setStatus('Move failed: source parent is not a valid container.', 'error');
    return;
  }

  if (isObject(targetNode) && sourceParentType === 'object') {
    const sourceKeyText = String(sourceKey);
    if (Object.prototype.hasOwnProperty.call(targetNode, sourceKeyText)) {
      setStatus(`Move blocked: "${sourceKeyText}" already exists in the target object.`, 'error');
      return;
    }
  }

  const moved = removeNodeAtPath(tab.parsedData, sourcePath);
  if (!moved) {
    setStatus('Move failed: source path not found.', 'error');
    return;
  }

  if (Array.isArray(targetNode)) {
    if (sourceParentType === 'object') {
      targetNode.push({
        [String(sourceKey)]: sourceValue
      });
    } else {
      targetNode.push(moved.value);
    }
  } else {
    const nextKey = sourceParentType === 'object' ? String(sourceKey) : makeUniqueKey(targetNode, 'movedItem');
    targetNode[nextKey] = moved.value;
  }

  applyStructureChange('Moved node in Structure View.');
}

function handleDragStart(event) {
  if (event.target.closest('.node-edit-btn')) {
    return;
  }

  const source = event.target.closest('[data-drag-source-path]');
  if (!source) {
    return;
  }

  const sourcePath = decodePath(source.dataset.dragSourcePath || '');
  if (!sourcePath || sourcePath.length === 0) {
    return;
  }

  dragState = {
    sourcePath
  };

  source.classList.add('node-dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', source.dataset.dragSourcePath);
  }
}

function handleDragEnd() {
  treeRoot.querySelectorAll('.node-dragging').forEach((el) => {
    el.classList.remove('node-dragging');
  });
  clearDropHighlights();
  dragState = null;
}

function handleDragOver(event) {
  const target = event.target.closest('[data-drop-target-path]');
  if (!target || !dragState) {
    return;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }

  clearDropHighlights();
  target.classList.add('drop-target-active');
}

function handleDragLeave(event) {
  const target = event.target.closest('[data-drop-target-path]');
  if (!target) {
    return;
  }

  target.classList.remove('drop-target-active');
}

function handleDrop(event) {
  const target = event.target.closest('[data-drop-target-path]');
  if (!target || !dragState) {
    return;
  }

  event.preventDefault();
  clearDropHighlights();

  const targetPath = decodePath(target.dataset.dropTargetPath || '');
  if (!targetPath) {
    return;
  }

  applyMove(dragState.sourcePath, targetPath);
}

treeRoot.addEventListener('click', handleEditClick);
treeRoot.addEventListener('dragstart', handleDragStart);
treeRoot.addEventListener('dragend', handleDragEnd);
treeRoot.addEventListener('dragover', handleDragOver);
treeRoot.addEventListener('dragleave', handleDragLeave);
treeRoot.addEventListener('drop', handleDrop);
treeRoot.addEventListener(
  'toggle',
  (event) => {
    if (!(event.target instanceof HTMLDetailsElement)) {
      return;
    }
    const tab = currentTab();
    const pathToken = event.target.dataset.nodePath;
    if (!tab || !pathToken) {
      return;
    }
    if (event.target.open) {
      tab.expandedPaths.add(pathToken);
    } else {
      tab.expandedPaths.delete(pathToken);
    }
  },
  true
);

inputBox.addEventListener('input', () => {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  tab.input = inputBox.value;
  refreshDirtyState(tab);
  updateSaveButton(tab);
  tab.hideEditorForLargeFile = false;
  tab.showEditorOverride = false;
  applyPaneVisibility(tab);
  syncHighlight();

  clearTimeout(parseDebounce);
  parseDebounce = setTimeout(() => parseAndRender(false), 250);
});

inputBox.addEventListener('scroll', () => {
  highlightLayer.scrollTop = inputBox.scrollTop;
  highlightLayer.scrollLeft = inputBox.scrollLeft;
});

if (renderBtn) {
  renderBtn.addEventListener('click', () => parseAndRender(true));
}

if (openFileButton) {
  openFileButton.addEventListener('click', async () => {
    const api = window.structViewApi;
    if (!api || typeof api.openFileDialog !== 'function') {
      setStatus('Open file is only available in the desktop app.', 'error');
      return;
    }

    try {
      const result = await api.openFileDialog();
      if (!result || result.canceled) {
        return;
      }
      if (!result.ok) {
        const message = result.error || 'Unable to open file.';
        setStatus(`Open failed: ${message}`, 'error');
        return;
      }
      loadOpenedFile(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Open failed: ${message}`, 'error');
    }
  });
}

if (clearTextButton) {
  clearTextButton.addEventListener('click', () => {
    const tab = currentTab();
    if (!tab) {
      return;
    }

    clearTimeout(parseDebounce);
    tab.input = '';
    tab.parsedData = null;
    tab.matches = [];
    tab.activeMatchIndex = -1;
    tab.expandedPaths = new Set();
    tab.hideEditorForLargeFile = false;
    tab.showEditorOverride = false;
    refreshDirtyState(tab);

    inputBox.value = '';
    syncHighlight();
    applyPaneVisibility(tab);
    updateSaveButton(tab);
    treeRoot.innerHTML = '<p class="node-meta">Structure will appear here after successful parsing.</p>';
    if (searchStatus) {
      searchStatus.textContent = tab.search.trim() ? `No matches for "${tab.search.trim()}".` : 'Showing full structure.';
    }
    updateMatchButtons();
    setStatus('Cleared all input text.', 'success');
    inputBox.focus();
  });
}

if (showTextPaneButton) {
  showTextPaneButton.addEventListener('click', () => {
    const tab = currentTab();
    if (!tab) {
      return;
    }
    tab.showEditorOverride = true;
    applyPaneVisibility(tab);
    inputBox.focus();
  });
}

if (saveFileButton) {
  saveFileButton.addEventListener('click', () => {
    saveCurrentTab();
  });
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

const api = window.structViewApi;
if (api && typeof api.onOpenFile === 'function') {
  api.onOpenFile((payload) => {
    loadOpenedFile(payload);
  });
}
if (api && typeof api.onRequestSave === 'function') {
  api.onRequestSave(() => {
    saveCurrentTab();
  });
}

const appSettings = loadAppSettings();
const initialInput = appSettings.startWithEmptyInput ? '' : String(appSettings.defaultInput || '');
addTab(initialInput);
applyPaneVisibility(currentTab());
updateSaveButton(currentTab());
if (initialInput.trim()) {
  parseAndRender(false);
}
