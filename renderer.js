const tabsBar = document.getElementById('tabs-bar');
const addTabButton = document.getElementById('add-tab-btn');
const inputBox = document.getElementById('input-box');
const lineNumberLayer = document.getElementById('line-number-layer');
const highlightLayer = document.getElementById('highlight-layer');
const editorWrap = document.getElementById('editor-wrap');
const layoutEl = document.querySelector('.layout');
const paneResizer = document.getElementById('pane-resizer');
const treeRoot = document.getElementById('tree-root');
const statusEl = document.getElementById('status');
const searchInput = document.getElementById('tree-search');
const searchPrevButton = document.getElementById('tree-search-prev');
const searchNextButton = document.getElementById('tree-search-next');
const searchClearButton = document.getElementById('tree-search-clear');
const searchStatus = document.getElementById('search-status');
const nodeBreadcrumb = document.getElementById('node-breadcrumb');
const renderBtn = document.getElementById('render-btn') || document.getElementById('generate-btn');
const openFileButton = document.getElementById('open-file-btn');
const hideTextPaneButton = document.getElementById('hide-text-pane-btn');
const saveFileButton = document.getElementById('save-file-btn');
const clearTextButton = document.getElementById('clear-text-btn');
const showTextPaneButton = document.getElementById('show-text-pane-btn');
const beautifyButton = document.getElementById('beautify-btn');
const bodyEl = document.body;
const LARGE_FILE_HIDE_INPUT_LINE_THRESHOLD = 10000;
const LARGE_EDIT_CHAR_THRESHOLD = 200000;
const MOBILE_LAYOUT_BREAKPOINT = 980;
const MIN_PANE_WIDTH_PX = 280;

let parseDebounce;
let nextTabId = 1;
const tabs = [];
let activeTabId = null;
let dragState = null;
let renderedLineNumberCount = -1;
let parseRequestId = 0;
let searchRequestId = 0;
let searchDebounce;
let paneResizeState = null;
let paneResizeGuide = null;
let tabRenameState = null;
let renderedTreeTabId = null;

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

function getTabById(tabId) {
  return tabs.find((tab) => tab.id === tabId) || null;
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
    asyncSearchMode: false,
    asyncSearchResults: [],
    sourceFilePath: null,
    sourceFileName: null,
    savedInputSnapshot: initialInput,
    dirty: false,
    hideEditorForLargeFile: false,
    interactionPath: null
  };
}

function defaultTabTitle(tabId) {
  return `Tab ${tabId}`;
}

function normalizeTabTitle(rawTitle, fallbackTitle) {
  const trimmed = String(rawTitle ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed || fallbackTitle;
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

function isLargeInputText(text) {
  if (typeof text !== 'string') {
    return false;
  }
  if (text.length >= LARGE_EDIT_CHAR_THRESHOLD) {
    return true;
  }
  return countLines(text) >= LARGE_FILE_HIDE_INPUT_LINE_THRESHOLD;
}

function shouldHideEditor(tab) {
  return Boolean(tab && tab.hideEditorForLargeFile);
}

function updatePaneResizerVisibility(tab = currentTab()) {
  if (!paneResizer) {
    return;
  }
  paneResizer.hidden = shouldHideEditor(tab) || window.innerWidth <= MOBILE_LAYOUT_BREAKPOINT;
}

function applyPaneVisibility(tab = currentTab()) {
  const hideEditor = shouldHideEditor(tab);
  bodyEl.classList.toggle('structure-only-mode', hideEditor);
  if (hideTextPaneButton) {
    hideTextPaneButton.hidden = hideEditor;
  }
  if (showTextPaneButton) {
    showTextPaneButton.hidden = !hideEditor;
  }
  updatePaneResizerVisibility(tab);
  updateBeautifyVisibility(tab);
}

function setEditorPaneSize(px) {
  if (!layoutEl || !Number.isFinite(px)) {
    return;
  }
  layoutEl.style.setProperty('--editor-pane-size', `${Math.round(px)}px`);
}

function ensurePaneResizeGuide() {
  if (!layoutEl) {
    return null;
  }
  if (!paneResizeGuide) {
    paneResizeGuide = document.createElement('div');
    paneResizeGuide.className = 'pane-resize-guide';
    paneResizeGuide.hidden = true;
    layoutEl.appendChild(paneResizeGuide);
  }
  return paneResizeGuide;
}

function beginPaneResize(event) {
  if (!layoutEl || !paneResizer || !event || window.innerWidth <= MOBILE_LAYOUT_BREAKPOINT) {
    return;
  }
  if (shouldHideEditor(currentTab())) {
    return;
  }

  const editorPanel = layoutEl.querySelector('.editor-panel');
  if (!editorPanel) {
    return;
  }

  const layoutRect = layoutEl.getBoundingClientRect();
  const startWidth = editorPanel.getBoundingClientRect().width;
  const guideStartX = event.clientX - layoutRect.left;
  const maxPaneWidth = Math.max(
    MIN_PANE_WIDTH_PX,
    layoutRect.width - MIN_PANE_WIDTH_PX - (paneResizer.getBoundingClientRect().width || 12)
  );

  paneResizeState = {
    startX: event.clientX,
    startWidth,
    minWidth: MIN_PANE_WIDTH_PX,
    maxWidth: maxPaneWidth,
    targetWidth: startWidth,
    guideStartX
  };

  const guide = ensurePaneResizeGuide();
  if (guide) {
    guide.style.left = `${guideStartX}px`;
    guide.hidden = false;
  }

  bodyEl.classList.add('resizing-panes');
  event.preventDefault();
}

function onPaneResizeMove(event) {
  if (!paneResizeState) {
    return;
  }

  const delta = event.clientX - paneResizeState.startX;
  const proposed = paneResizeState.startWidth + delta;
  const clamped = Math.min(paneResizeState.maxWidth, Math.max(paneResizeState.minWidth, proposed));
  paneResizeState.targetWidth = clamped;

  if (paneResizeGuide) {
    const guideX = paneResizeState.guideStartX + (clamped - paneResizeState.startWidth);
    paneResizeGuide.style.left = `${guideX}px`;
  }
}

function endPaneResize() {
  if (!paneResizeState) {
    return;
  }

  if (Number.isFinite(paneResizeState.targetWidth)) {
    setEditorPaneSize(paneResizeState.targetWidth);
  }
  if (paneResizeGuide) {
    paneResizeGuide.hidden = true;
  }
  paneResizeState = null;
  bodyEl.classList.remove('resizing-panes');
}

function hasYamlFileExtension(fileName) {
  if (typeof fileName !== 'string') {
    return false;
  }
  return /\.ya?ml$/i.test(fileName.trim());
}

function isYamlTab(tab) {
  if (!tab) {
    return false;
  }
  if (tab.parsedFormat === 'YAML') {
    return true;
  }
  return hasYamlFileExtension(tab.sourceFileName || '');
}

function updateBeautifyVisibility(tab = currentTab()) {
  if (!beautifyButton) {
    return;
  }
  beautifyButton.hidden = isYamlTab(tab);
}

function formatPathSegment(segment) {
  if (typeof segment === 'number') {
    return `[${segment}]`;
  }
  return String(segment);
}

function clearBreadcrumbTarget() {
  treeRoot.querySelectorAll('.breadcrumb-target').forEach((el) => {
    el.classList.remove('breadcrumb-target');
  });
}

function focusStructurePath(path, scroll = true) {
  if (!Array.isArray(path)) {
    return null;
  }

  for (let i = 0; i < path.length; i += 1) {
    const token = encodePath(path.slice(0, i + 1));
    const details = treeRoot.querySelector(`details[data-node-path='${CSS.escape(token)}']`);
    if (details) {
      details.open = true;
    }
  }

  const token = encodePath(path);
  const nodeEl = treeRoot.querySelector(`[data-node-path='${CSS.escape(token)}']`);
  if (!nodeEl) {
    return null;
  }

  const target =
    nodeEl.querySelector('.node-key') ||
    nodeEl.querySelector('.primitive-value') ||
    nodeEl.querySelector('.node-meta') ||
    nodeEl;
  clearBreadcrumbTarget();
  target.classList.add('breadcrumb-target');
  if (scroll) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return target;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findBestTextIndexForPath(tab, path) {
  if (!tab || typeof tab.input !== 'string') {
    return 0;
  }
  if (!Array.isArray(path) || path.length === 0) {
    return 0;
  }

  const source = tab.input;
  const keyTrail = path.filter((segment) => typeof segment === 'string');
  if (keyTrail.length === 0) {
    return 0;
  }

  const targetKey = keyTrail[keyTrail.length - 1];
  const ancestorKeys = keyTrail.slice(0, -1);
  const jsonPattern = new RegExp(`"${escapeRegExp(targetKey)}"\\s*:`, 'g');
  const yamlPattern = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(targetKey)}\\s*:`, 'g');
  const candidates = [];

  let match;
  while ((match = jsonPattern.exec(source)) !== null) {
    candidates.push(match.index);
  }
  while ((match = yamlPattern.exec(source)) !== null) {
    candidates.push(match.index + (match[0].startsWith('\n') ? 1 : 0));
  }

  if (candidates.length === 0) {
    const fallback = source.toLowerCase().indexOf(String(targetKey).toLowerCase());
    return fallback >= 0 ? fallback : 0;
  }

  let bestIndex = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const beforeText = source.slice(0, candidate).toLowerCase();
    let score = 0;
    let cursor = beforeText.length;
    for (let i = ancestorKeys.length - 1; i >= 0; i -= 1) {
      const ancestor = String(ancestorKeys[i]).toLowerCase();
      const found = beforeText.lastIndexOf(ancestor, cursor - 1);
      if (found === -1) {
        continue;
      }
      score += 1;
      cursor = found;
    }
    if (score > bestScore || (score === bestScore && candidate > bestIndex)) {
      bestScore = score;
      bestIndex = candidate;
    }
  }

  return bestIndex;
}

function jumpTextPaneToPath(path) {
  const tab = currentTab();
  if (!tab || typeof tab.input !== 'string') {
    return;
  }

  const index = findBestTextIndexForPath(tab, path);
  const safeIndex = Math.max(0, Math.min(index, tab.input.length));
  inputBox.focus();
  inputBox.setSelectionRange(safeIndex, safeIndex);
  inputBox.dispatchEvent(new Event('scroll'));
}

function jumpToPath(path) {
  if (!Array.isArray(path)) {
    return;
  }
  setInteractionPath(path);
  focusStructurePath(path, true);
  jumpTextPaneToPath(path);
}

function renderInteractionBreadcrumb(tab = currentTab()) {
  if (!nodeBreadcrumb) {
    return;
  }

  nodeBreadcrumb.innerHTML = '';
  const path = tab && Array.isArray(tab.interactionPath) ? tab.interactionPath : null;
  if (!path) {
    const empty = document.createElement('span');
    empty.className = 'breadcrumb-empty';
    empty.textContent = 'No node selected.';
    nodeBreadcrumb.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const rootItem = document.createElement('button');
  rootItem.type = 'button';
  rootItem.className = 'breadcrumb-item';
  rootItem.textContent = 'root';
  rootItem.dataset.breadcrumbPath = encodePath([]);
  if (path.length === 0) {
    rootItem.classList.add('active');
    rootItem.setAttribute('aria-current', 'location');
  }
  fragment.appendChild(rootItem);

  path.forEach((segment, index) => {
    const separator = document.createElement('span');
    separator.className = 'breadcrumb-separator';
    separator.textContent = '/';
    fragment.appendChild(separator);

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'breadcrumb-item';
    item.textContent = formatPathSegment(segment);
    const segmentPath = path.slice(0, index + 1);
    item.dataset.breadcrumbPath = encodePath(segmentPath);
    if (index === path.length - 1) {
      item.classList.add('active');
      item.setAttribute('aria-current', 'location');
    }
    fragment.appendChild(item);
  });

  nodeBreadcrumb.appendChild(fragment);
}

function setInteractionPath(path) {
  const tab = currentTab();
  if (!tab) {
    return;
  }
  tab.interactionPath = Array.isArray(path) ? [...path] : null;
  renderInteractionBreadcrumb(tab);
}

function updateInteractionPathFromTarget(target) {
  if (!(target instanceof Element)) {
    return;
  }
  const nodeHost = target.closest('[data-node-path]');
  if (!nodeHost || typeof nodeHost.dataset.nodePath !== 'string') {
    return;
  }
  const path = decodePath(nodeHost.dataset.nodePath);
  if (!path) {
    return;
  }
  setInteractionPath(path);
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

function beautifyCurrentTab() {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  const raw = tab.input;
  if (!raw || !raw.trim()) {
    setStatus('Nothing to beautify. Paste JSON first.', 'error');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    setStatus('Beautify supports JSON only. Input is not valid JSON.', 'error');
    return;
  }

  const beautified = JSON.stringify(parsed, null, 4);
  tab.input = beautified;
  tab.parsedData = parsed;
  tab.parsedFormat = 'JSON';
  tab.parseFallback = false;

  refreshDirtyState(tab);
  updateSaveButton(tab);
  inputBox.value = beautified;
  syncHighlight();
  applyPaneVisibility(tab);
  updateBeautifyVisibility(tab);
  setStatus('Beautified JSON with 4-space indentation.', 'success');
  parseAndRender(true);
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

function captureExpandedPaths(tab = null) {
  const targetTab = tab || getTabById(renderedTreeTabId) || currentTab();
  if (!targetTab) {
    return;
  }

  if (renderedTreeTabId === null && !tab) {
    return;
  }

  const detailsNodes = treeRoot.querySelectorAll('details[data-node-path]');
  if (detailsNodes.length === 0) {
    targetTab.expandedPaths = new Set();
    return;
  }

  const next = new Set();
  detailsNodes.forEach((details) => {
    if (details.open) {
      next.add(details.dataset.nodePath);
    }
  });
  targetTab.expandedPaths = next;
}

function clearRenderedTree() {
  treeRoot.innerHTML = '';
  renderedTreeTabId = activeTabId;
}

function setRenderedTreeContent(tabId, content) {
  treeRoot.innerHTML = '';
  if (content) {
    treeRoot.appendChild(content);
  }
  renderedTreeTabId = tabId;
}

function showTreePlaceholder(html) {
  treeRoot.innerHTML = html;
  renderedTreeTabId = activeTabId;
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

function parseEditableValue(rawInput, originalValue) {
  const raw = rawInput.trim();

  if (!raw) {
    return '';
  }

  const isDoubleQuoted = raw.startsWith('"') && raw.endsWith('"');
  const isSingleQuoted = raw.startsWith("'") && raw.endsWith("'");

  if (isDoubleQuoted) {
    return JSON.parse(raw);
  }

  if (isSingleQuoted && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\'/g, "'");
  }

  // If the original value is a string and user keeps it unquoted, preserve string type
  // unless they've explicitly entered a valid non-string literal.
  if (typeof originalValue === 'string') {
    const manualTypeChangeLiteral =
      raw === 'null' || raw === 'true' || raw === 'false' || /^-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?$/.test(raw);

    if (manualTypeChangeLiteral) {
      return JSON.parse(raw);
    }

    if (raw.startsWith('{') || raw.startsWith('[')) {
      return JSON.parse(raw);
    }

    return rawInput;
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

function getDefaultOpenDepth() {
  const tab = currentTab();
  return tab && isLargeInputText(tab.input) ? 1 : 2;
}

function createPrimitiveNodeShell(label, value, query, path, indexMeta = '') {
  const pathToken = encodePath(path);
  const wrapper = document.createElement('div');
  wrapper.className = 'node primitive-row';
  wrapper.dataset.nodePath = pathToken;

  const content = document.createElement('div');
  content.className = 'primitive';

  if (path.length > 0) {
    const dragHandle = document.createElement('span');
    dragHandle.className = 'node-drag-handle';
    dragHandle.textContent = '::';
    dragHandle.draggable = true;
    dragHandle.dataset.dragSourcePath = pathToken;
    dragHandle.title = 'Drag to move this node';
    content.appendChild(dragHandle);
  }

  if (indexMeta) {
    const indexBadge = document.createElement('span');
    indexBadge.className = 'node-meta';
    indexBadge.textContent = indexMeta;
    content.appendChild(indexBadge);
  }

  const key = document.createElement('span');
  key.className = 'node-key';
  key.textContent = label;
  if (query && containsQuery(query, label)) {
    key.classList.add('match-hit');
  }

  const type = document.createElement('span');
  type.className = 'node-type';
  type.textContent = nodeType(value);

  const primitiveValue = document.createElement('span');
  primitiveValue.className = 'primitive-value';
  const primitiveText = formatPrimitive(value);
  primitiveValue.textContent = primitiveText;
  if (query && containsQuery(query, primitiveText)) {
    primitiveValue.classList.add('match-hit');
  }

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'node-edit-btn';
  editButton.textContent = 'Edit';
  editButton.dataset.editPath = pathToken;
  editButton.draggable = false;

  const editor = document.createElement('div');
  editor.className = 'node-inline-editor';
  editor.dataset.editorPath = pathToken;
  editor.dataset.editorMode = 'primitive';

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.className = 'node-inline-input node-inline-key';
  keyInput.value = label;
  keyInput.disabled = !canRenamePath(path);

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.className = 'node-inline-input node-inline-value';
  valueInput.value = JSON.stringify(value);

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'node-inline-save';
  saveButton.textContent = 'Save';
  saveButton.dataset.savePath = pathToken;
  saveButton.dataset.saveMode = 'primitive';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'node-inline-cancel';
  cancelButton.textContent = 'Cancel';
  cancelButton.dataset.cancelPath = pathToken;

  editor.append(keyInput, valueInput, saveButton, cancelButton);
  content.append(key, type, primitiveValue, editButton);
  wrapper.append(content, editor);
  return wrapper;
}

function createBranchNodeShell(label, value, depth, query, path, indexMeta = '') {
  const tab = currentTab();
  const pathToken = encodePath(path);
  const wrapper = document.createElement('div');
  wrapper.className = 'node';
  wrapper.dataset.nodePath = pathToken;

  const details = document.createElement('details');
  details.dataset.nodePath = pathToken;
  details.open = Boolean(tab && tab.expandedPaths && tab.expandedPaths.has(pathToken)) || depth < getDefaultOpenDepth();

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
  branchEdit.dataset.editPath = pathToken;
  branchEdit.draggable = false;

  const branchEditor = document.createElement('div');
  branchEditor.className = 'node-inline-editor';
  branchEditor.dataset.editorPath = pathToken;
  branchEditor.dataset.editorMode = 'branch';

  const branchKeyInput = document.createElement('input');
  branchKeyInput.type = 'text';
  branchKeyInput.className = 'node-inline-input node-inline-key';
  branchKeyInput.value = label;
  branchKeyInput.disabled = !canRenamePath(path);

  const branchSave = document.createElement('button');
  branchSave.type = 'button';
  branchSave.className = 'node-inline-save';
  branchSave.textContent = 'Save';
  branchSave.dataset.savePath = pathToken;
  branchSave.dataset.saveMode = 'branch';

  const branchCancel = document.createElement('button');
  branchCancel.type = 'button';
  branchCancel.className = 'node-inline-cancel';
  branchCancel.textContent = 'Cancel';
  branchCancel.dataset.cancelPath = pathToken;

  branchEditor.append(branchKeyInput, branchSave, branchCancel);
  summary.append(key, type, meta, branchEdit);
  details.append(summary, branchEditor);

  const childrenWrap = document.createElement('div');
  childrenWrap.className = 'node-children';
  childrenWrap.dataset.dropTargetPath = pathToken;
  details.dataset.childrenBuilt = 'false';
  details.appendChild(childrenWrap);
  wrapper.appendChild(details);

  return {
    wrapper,
    details,
    childrenWrap
  };
}

function pushChildFrames(stack, value, depth, path, container) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      stack.push({
        label: getArrayItemLabel(item),
        value: item,
        depth,
        path: [...path, index],
        indexMeta: `index ${index}`,
        container
      });
    }
    return;
  }

  const entries = Object.entries(value);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [childKey, childValue] = entries[index];
    stack.push({
      label: childKey,
      value: childValue,
      depth,
      path: [...path, childKey],
      indexMeta: '',
      container
    });
  }
}

function buildVisibleTreeFragment(label, value, depth, query, path, indexMeta = '') {
  const fragment = document.createDocumentFragment();
  const stack = [
    {
      label,
      value,
      depth,
      path,
      indexMeta,
      container: fragment
    }
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    const isBranch = isObject(frame.value) || Array.isArray(frame.value);

    if (!isBranch) {
      frame.container.appendChild(
        createPrimitiveNodeShell(frame.label, frame.value, query, frame.path, frame.indexMeta)
      );
      continue;
    }

    const branch = createBranchNodeShell(frame.label, frame.value, frame.depth, query, frame.path, frame.indexMeta);
    frame.container.appendChild(branch.wrapper);

    if (branch.details.open) {
      branch.details.dataset.childrenBuilt = 'true';
      pushChildFrames(stack, frame.value, frame.depth + 1, frame.path, branch.childrenWrap);
    }
  }

  return fragment;
}

function buildVisibleChildrenFragment(value, depth, query, path) {
  const fragment = document.createDocumentFragment();
  const stack = [];
  pushChildFrames(stack, value, depth, path, fragment);

  while (stack.length > 0) {
    const frame = stack.pop();
    const isBranch = isObject(frame.value) || Array.isArray(frame.value);

    if (!isBranch) {
      frame.container.appendChild(
        createPrimitiveNodeShell(frame.label, frame.value, query, frame.path, frame.indexMeta)
      );
      continue;
    }

    const branch = createBranchNodeShell(frame.label, frame.value, frame.depth, query, frame.path, frame.indexMeta);
    frame.container.appendChild(branch.wrapper);

    if (branch.details.open) {
      branch.details.dataset.childrenBuilt = 'true';
      pushChildFrames(stack, frame.value, frame.depth + 1, frame.path, branch.childrenWrap);
    }
  }

  return fragment;
}

function populateBranchChildren(detailsEl) {
  if (!(detailsEl instanceof HTMLDetailsElement) || detailsEl.dataset.childrenBuilt === 'true') {
    return;
  }

  const tab = currentTab();
  if (!tab || tab.parsedData === null) {
    return;
  }

  const path = decodePath(detailsEl.dataset.nodePath || '');
  if (!path) {
    return;
  }

  const node = getNodeAtPath(tab.parsedData, path);
  if (!isObject(node) && !Array.isArray(node)) {
    return;
  }

  const childrenWrap = detailsEl.querySelector('.node-children');
  if (!childrenWrap) {
    return;
  }

  const depth = path.length + 1;
  const query = (tab.search || '').trim().toLowerCase();
  childrenWrap.appendChild(buildVisibleChildrenFragment(node, depth, query, path));
  detailsEl.dataset.childrenBuilt = 'true';
}

function findSyncMatches(root, query, limit = 2000) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const matches = [];
  const seen = new Set();
  const stack = [{ value: root, path: [] }];

  while (stack.length > 0 && matches.length < limit) {
    const frame = stack.pop();

    if (Array.isArray(frame.value)) {
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: frame.value[index],
          path: [...frame.path, index]
        });
      }
      continue;
    }

    if (isObject(frame.value)) {
      const entries = Object.entries(frame.value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, childValue] = entries[index];
        const childPath = [...frame.path, key];
        if (containsQuery(normalized, key)) {
          const token = encodePath(childPath);
          if (!seen.has(token)) {
            seen.add(token);
            matches.push({ path: childPath, target: 'key' });
            if (matches.length >= limit) {
              break;
            }
          }
        }
        stack.push({
          value: childValue,
          path: childPath
        });
      }
      continue;
    }

    if (containsQuery(normalized, formatPrimitive(frame.value))) {
      const token = encodePath(frame.path);
      if (!seen.has(token)) {
        seen.add(token);
        matches.push({ path: frame.path, target: 'value' });
      }
    }
  }

  return matches;
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
  valueInput.value = JSON.stringify(value);

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
      const parsedValue = parseEditableValue(valueInput.value, value);
      tab.parsedData = setNodeAtPath(tab.parsedData, nextPath, parsedValue);
      setInteractionPath(nextPath);
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
      const nextPath = renamePathKeyIfNeeded(path, branchKeyInput.value);
      setInteractionPath(nextPath);
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

function getMatchCount(tab) {
  if (!tab) {
    return 0;
  }
  if (tab.asyncSearchMode) {
    return Array.isArray(tab.asyncSearchResults) ? tab.asyncSearchResults.length : 0;
  }
  return Array.isArray(tab.matches) ? tab.matches.length : 0;
}

function updateMatchButtons() {
  const tab = currentTab();
  const enabled = getMatchCount(tab) > 0;

  if (searchPrevButton) {
    searchPrevButton.disabled = !enabled;
  }
  if (searchNextButton) {
    searchNextButton.disabled = !enabled;
  }
}

function focusPathMatch(match, scroll = true) {
  const path = Array.isArray(match) ? match : match && Array.isArray(match.path) ? match.path : null;
  if (!Array.isArray(path)) {
    return null;
  }
  const targetType = match && typeof match === 'object' && match.target === 'value' ? 'value' : 'key';

  for (let i = 0; i < path.length; i += 1) {
    const prefix = path.slice(0, i + 1);
    const token = encodePath(prefix);
    const selector = `details[data-node-path='${CSS.escape(token)}']`;
    const details = treeRoot.querySelector(selector);
    if (details) {
      details.open = true;
      populateBranchChildren(details);
    }
  }

  const pathToken = encodePath(path);
  const nodeSelector = `[data-node-path='${CSS.escape(pathToken)}']`;
  const nodeEl = treeRoot.querySelector(nodeSelector);
  if (!nodeEl) {
    return null;
  }

  let target = nodeEl.querySelector('.node-key') || nodeEl;
  if (targetType === 'value') {
    target = nodeEl.querySelector('.primitive-value') || nodeEl.querySelector('.node-meta') || target;
  }
  target.classList.add('active-match');
  if (scroll) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  setInteractionPath(path);
  return target;
}

function setActiveMatch(index, query, scroll = true) {
  const tab = currentTab();
  if (!tab || !searchStatus) {
    return;
  }

  const totalMatches = getMatchCount(tab);
  if (totalMatches === 0) {
    tab.activeMatchIndex = -1;
    searchStatus.textContent = `No matches for "${query}".`;
    updateMatchButtons();
    return;
  }

  const normalizedIndex = ((index % totalMatches) + totalMatches) % totalMatches;
  tab.activeMatchIndex = normalizedIndex;

  clearActiveMatch();
  if (tab.asyncSearchMode) {
    const match = tab.asyncSearchResults[normalizedIndex];
    focusPathMatch(match, scroll);
  } else {
    const match = tab.matches[normalizedIndex];
    focusPathMatch(match, scroll);
  }

  searchStatus.textContent = `${tab.activeMatchIndex + 1} / ${totalMatches} match${totalMatches === 1 ? '' : 'es'} for "${query}".`;
  updateMatchButtons();
}

function renderStructure(data, query = '', jumpToMatch = false, focusNextButton = false) {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  if (Array.isArray(tab.interactionPath) && tab.interactionPath.length > 0) {
    const activeNode = getNodeAtPath(data, tab.interactionPath);
    if (activeNode === undefined) {
      tab.interactionPath = null;
    }
  }

  captureExpandedPaths();

  const normalizedQuery = query.trim().toLowerCase();
  const matches = normalizedQuery ? findSyncMatches(data, normalizedQuery) : [];
  setRenderedTreeContent(tab.id, buildVisibleTreeFragment('root', data, 0, normalizedQuery, []));

  tab.asyncSearchMode = false;
  tab.asyncSearchResults = [];
  tab.matches = matches;

  if (!normalizedQuery) {
    clearActiveMatch();
    tab.activeMatchIndex = -1;
    if (searchStatus) {
      searchStatus.textContent = 'Showing full structure.';
    }
    updateMatchButtons();
    renderInteractionBreadcrumb(tab);
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
  renderInteractionBreadcrumb(tab);
}

async function parseSource(source) {
  const api = window.structViewApi;

  if (api && typeof api.parseInputAsync === 'function') {
    return api.parseInputAsync(source);
  }

  if (api && typeof api.parseInput === 'function') {
    return Promise.resolve(api.parseInput(source));
  }

  try {
    return Promise.resolve({
      ok: true,
      format: 'JSON',
      data: JSON.parse(source),
      fallback: true
    });
  } catch (jsonError) {
    return Promise.resolve({
      ok: false,
      error:
        'Parser unavailable in browser preview mode. JSON works here, but YAML needs the Electron app (`npm start`). ' +
        `JSON error: ${jsonError.message}`
    });
  }
}

function shouldUseAsyncSearch(tab) {
  return Boolean(tab && tab.parsedData !== null && isLargeInputText(tab.input));
}

async function runAsyncSearch(query, focusNextButton = false) {
  const tab = currentTab();
  if (!tab || tab.parsedData === null || !searchStatus) {
    return;
  }

  const trimmed = query.trim();
  if (!trimmed) {
    tab.asyncSearchMode = false;
    tab.asyncSearchResults = [];
    renderStructure(tab.parsedData, '', false, false);
    return;
  }

  const requestId = ++searchRequestId;
  searchStatus.textContent = `Searching "${trimmed}"...`;
  updateMatchButtons();

  const api = window.structViewApi;
  if (!api || typeof api.searchStructureAsync !== 'function') {
    renderStructure(tab.parsedData, query, true, focusNextButton);
    return;
  }

  const result = await api.searchStructureAsync({
    source: tab.input,
    query: trimmed,
    limit: 2000
  });

  if (requestId !== searchRequestId || tab !== currentTab()) {
    return;
  }

  if (!result || !result.ok) {
    const message = result && result.error ? result.error : 'Search failed.';
    searchStatus.textContent = message;
    tab.asyncSearchMode = false;
    tab.asyncSearchResults = [];
    updateMatchButtons();
    return;
  }

  tab.asyncSearchMode = true;
  tab.asyncSearchResults = Array.isArray(result.results)
    ? result.results
    : Array.isArray(result.paths)
      ? result.paths.map((path) => ({ path, target: 'key' }))
      : [];
  tab.matches = [];
  tab.activeMatchIndex = -1;

  renderStructure(tab.parsedData, '', false, false);
  tab.asyncSearchMode = true;
  tab.asyncSearchResults = Array.isArray(result.results)
    ? result.results
    : Array.isArray(result.paths)
      ? result.paths.map((path) => ({ path, target: 'key' }))
      : [];

  if (tab.asyncSearchResults.length === 0) {
    searchStatus.textContent = `No matches for "${trimmed}".`;
    updateMatchButtons();
    return;
  }

  setActiveMatch(0, trimmed, true);
  if (focusNextButton && searchNextButton && !searchNextButton.disabled) {
    searchNextButton.focus();
  }
}

async function parseAndRender(focusNextButton = false) {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  const requestId = ++parseRequestId;
  const source = tab.input;

  if (!focusNextButton && isLargeInputText(source)) {
    setStatus('Input changed. Click "Generate Structure" to refresh.', 'neutral');
    return;
  }

  try {
    if (!focusNextButton) {
      setStatus('Parsing input...', 'neutral');
    }
    const parsed = await parseSource(source);
    if (requestId !== parseRequestId || tab !== currentTab()) {
      return;
    }

    if (!parsed.ok) {
      tab.parsedData = null;
      tab.matches = [];
      tab.asyncSearchMode = false;
      tab.asyncSearchResults = [];
      tab.activeMatchIndex = -1;
      setStatus(parsed.error, 'error');
      showTreePlaceholder('<p class="node-meta">Structure will appear here after successful parsing.</p>');
      if (searchStatus) {
        searchStatus.textContent = 'Showing full structure.';
      }
      updateMatchButtons();
      tab.interactionPath = null;
      renderInteractionBreadcrumb(tab);
      applyPaneVisibility(tab);
      return;
    }

    tab.parsedData = parsed.data;
    tab.parsedFormat = parsed.format;
    tab.parseFallback = Boolean(parsed.fallback);
    if (tab.search.trim() && shouldUseAsyncSearch(tab)) {
      renderStructure(parsed.data, '', false, false);
      await runAsyncSearch(tab.search, focusNextButton && Boolean(tab.search.trim()));
      setStatus(`Parsed as ${parsed.format}. Expand any box to inspect nested values.`, 'success');
      applyPaneVisibility(tab);
      return;
    }
    renderStructure(parsed.data, tab.search, true, focusNextButton && Boolean(tab.search.trim()));
    setStatus(`Parsed as ${parsed.format}. Expand any box to inspect nested values.`, 'success');
    applyPaneVisibility(tab);
  } catch (error) {
    tab.parsedData = null;
    tab.matches = [];
    tab.asyncSearchMode = false;
    tab.asyncSearchResults = [];
    tab.activeMatchIndex = -1;
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Render failed: ${message}`, 'error');
    showTreePlaceholder('<p class="node-meta">Structure rendering failed. Check input and try again.</p>');
    if (searchStatus) {
      searchStatus.textContent = 'Showing full structure.';
    }
    updateMatchButtons();
    tab.interactionPath = null;
    renderInteractionBreadcrumb(tab);
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
  tab.asyncSearchMode = false;
  tab.asyncSearchResults = [];
  tab.activeMatchIndex = -1;
  tab.expandedPaths = new Set();
  tab.interactionPath = null;
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
  updateBeautifyVisibility(tab);
  updateSaveButton(tab);
  renderInteractionBreadcrumb(tab);
  parseAndRender(false);
}

function syncHighlight() {
  const tab = currentTab();
  const text = tab ? tab.input : '';
  updateLineNumbers(text);
  highlightLayer.innerHTML = `${highlightInput(text)}\n`;
  if (lineNumberLayer) {
    lineNumberLayer.scrollTop = inputBox.scrollTop;
  }
  highlightLayer.scrollTop = inputBox.scrollTop;
  highlightLayer.scrollLeft = inputBox.scrollLeft;
}

function updateLineNumbers(text) {
  if (!lineNumberLayer) {
    return;
  }

  const lineCount = Math.max(1, countLines(text));
  if (lineCount === renderedLineNumberCount) {
    return;
  }

  const numbers = new Array(lineCount);
  for (let i = 0; i < lineCount; i += 1) {
    numbers[i] = String(i + 1);
  }
  lineNumberLayer.textContent = `${numbers.join('\n')}\n`;
  renderedLineNumberCount = lineCount;
}

function focusTabRenameInput(tabId) {
  requestAnimationFrame(() => {
    const input = tabsBar ? tabsBar.querySelector(`.tab-rename-input[data-tab-id='${CSS.escape(String(tabId))}']`) : null;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    input.focus();
    input.select();
  });
}

function startTabRename(tabId) {
  const tab = tabs.find((entry) => entry.id === tabId);
  if (!tab) {
    return;
  }
  tabRenameState = {
    tabId,
    draft: tab.title
  };
  renderTabBar();
  focusTabRenameInput(tabId);
}

function cancelTabRename() {
  if (!tabRenameState) {
    return;
  }
  tabRenameState = null;
  renderTabBar();
}

function commitTabRename(tabId, nextTitle) {
  const tab = tabs.find((entry) => entry.id === tabId);
  if (!tab) {
    return;
  }
  tab.title = normalizeTabTitle(nextTitle, tab.title || defaultTabTitle(tab.id));
  tabRenameState = null;
  renderTabBar();
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
    const isRenaming = Boolean(tabRenameState && tabRenameState.tabId === tab.id);

    if (isRenaming) {
      const renameInput = document.createElement('input');
      renameInput.type = 'text';
      renameInput.className = 'tab-rename-input';
      renameInput.dataset.tabId = String(tab.id);
      renameInput.value = tabRenameState ? tabRenameState.draft : tab.title;
      renameInput.setAttribute('aria-label', `Rename ${tab.title}`);
      renameInput.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      renameInput.addEventListener('dblclick', (event) => {
        event.stopPropagation();
      });
      renameInput.addEventListener('contextmenu', (event) => {
        event.stopPropagation();
      });
      renameInput.addEventListener('input', (event) => {
        if (!tabRenameState || tabRenameState.tabId !== tab.id) {
          return;
        }
        tabRenameState.draft = event.target.value;
      });
      renameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitTabRename(tab.id, renameInput.value);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelTabRename();
        }
      });
      renameInput.addEventListener('blur', () => {
        if (!tabRenameState || tabRenameState.tabId !== tab.id) {
          return;
        }
        commitTabRename(tab.id, renameInput.value);
      });
      tabButton.appendChild(renameInput);
    } else {
      const label = document.createElement('span');
      label.className = 'tab-title';
      label.textContent = tab.title;
      tabButton.appendChild(label);
    }

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
      if (tabRenameState && tabRenameState.tabId === tab.id) {
        return;
      }
      switchTab(tab.id);
    });
    tabButton.addEventListener('dblclick', (event) => {
      if (event.target.closest('.tab-close')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      startTabRename(tab.id);
    });
    tabButton.addEventListener('contextmenu', (event) => {
      if (event.target.closest('.tab-close')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      startTabRename(tab.id);
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
  updateBeautifyVisibility(tab);
  renderInteractionBreadcrumb(tab);

  if (tab.parsedData !== null) {
    if (tab.search.trim() && shouldUseAsyncSearch(tab)) {
      renderStructure(tab.parsedData, '', false, false);
      runAsyncSearch(tab.search, false);
    } else {
      renderStructure(tab.parsedData, tab.search, false, false);
      if (tab.search.trim() && tab.matches.length > 0) {
        setActiveMatch(tab.activeMatchIndex >= 0 ? tab.activeMatchIndex : 0, tab.search.trim(), false);
      }
    }
  } else {
    showTreePlaceholder('<p class="node-meta">Structure will appear here after successful parsing.</p>');
    if (searchStatus) {
      searchStatus.textContent = tab.search.trim() ? `No matches for "${tab.search.trim()}".` : 'Showing full structure.';
    }
    updateMatchButtons();
  }
}

function switchTab(id) {
  captureExpandedPaths();
  tabRenameState = null;
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
  captureExpandedPaths();
  if (tabRenameState && tabRenameState.tabId === id) {
    tabRenameState = null;
  }
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
  const cancelButton = event.target.closest('.node-inline-cancel[data-cancel-path]');
  if (cancelButton) {
    const editor = cancelButton.closest('.node-inline-editor');
    if (editor) {
      editor.classList.remove('visible');
    }
    return;
  }

  const saveButton = event.target.closest('.node-inline-save[data-save-path]');
  if (saveButton) {
    event.preventDefault();
    event.stopPropagation();

    const path = decodePath(saveButton.dataset.savePath || '');
    const saveMode = saveButton.dataset.saveMode || 'primitive';
    const editor = saveButton.closest('.node-inline-editor');
    const tab = currentTab();
    if (!tab || !editor || !path || tab.parsedData === null) {
      return;
    }

    try {
      const keyInput = editor.querySelector('.node-inline-key');
      let nextPath = path;
      if (keyInput instanceof HTMLInputElement) {
        nextPath = renamePathKeyIfNeeded(path, keyInput.value);
      }

      if (saveMode === 'primitive') {
        const previousValue = getNodeAtPath(tab.parsedData, path);
        const valueInput = editor.querySelector('.node-inline-value');
        if (!(valueInput instanceof HTMLInputElement)) {
          return;
        }
        const parsedValue = parseEditableValue(valueInput.value, previousValue);
        tab.parsedData = setNodeAtPath(tab.parsedData, nextPath, parsedValue);
        setInteractionPath(nextPath);
        applyStructureChange('Updated element from Structure View.');
        return;
      }

      setInteractionPath(nextPath);
      applyStructureChange('Renamed element from Structure View.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Edit failed: ${message}`, 'error');
    }
    return;
  }

  const button = event.target.closest('.node-edit-btn[data-edit-path]');
  if (!button) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const editPath = decodePath(button.dataset.editPath || '');
  if (editPath) {
    setInteractionPath(editPath);
  }

  const host = button.closest('[data-node-path]');
  if (!host) {
    return;
  }

  treeRoot.querySelectorAll('.node-inline-editor.visible').forEach((editor) => {
    if (!host.contains(editor)) {
      editor.classList.remove('visible');
    }
  });

  const details = host.querySelector('details[data-node-path]');
  if (details) {
    details.open = true;
    populateBranchChildren(details);
  }

  const editor = host.querySelector('.node-inline-editor');
  if (!editor) {
    return;
  }

  editor.classList.toggle('visible');
  if (editor.classList.contains('visible')) {
    const primaryInput = editor.querySelector('.node-inline-value, .node-inline-key');
    if (primaryInput instanceof HTMLInputElement) {
      primaryInput.focus();
      primaryInput.select();
    }
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

  const source = event.target.closest('.node-drag-handle[data-drag-source-path]');
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
  setInteractionPath(sourcePath);

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
  setInteractionPath(targetPath);
}

treeRoot.addEventListener('click', handleEditClick);
treeRoot.addEventListener('click', (event) => {
  updateInteractionPathFromTarget(event.target);
});
treeRoot.addEventListener('focusin', (event) => {
  updateInteractionPathFromTarget(event.target);
});
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
      populateBranchChildren(event.target);
    } else {
      tab.expandedPaths.delete(pathToken);
    }
  },
  true
);

if (nodeBreadcrumb) {
  nodeBreadcrumb.addEventListener('click', (event) => {
    const target = event.target.closest('.breadcrumb-item[data-breadcrumb-path]');
    if (!target) {
      return;
    }
    const path = decodePath(target.dataset.breadcrumbPath || '');
    if (!path) {
      return;
    }
    jumpToPath(path);
  });
}

inputBox.addEventListener('input', () => {
  const tab = currentTab();
  if (!tab) {
    return;
  }

  tab.input = inputBox.value;
  tab.asyncSearchMode = false;
  tab.asyncSearchResults = [];
  refreshDirtyState(tab);
  updateSaveButton(tab);
  applyPaneVisibility(tab);
  syncHighlight();

  clearTimeout(parseDebounce);
  if (isLargeInputText(tab.input)) {
    setStatus('Input changed. Click "Generate Structure" to refresh.', 'neutral');
    return;
  }
  parseDebounce = setTimeout(() => {
    parseAndRender(false);
  }, 250);
});

inputBox.addEventListener('scroll', () => {
  if (lineNumberLayer) {
    lineNumberLayer.scrollTop = inputBox.scrollTop;
  }
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
    tab.interactionPath = null;
    refreshDirtyState(tab);

    inputBox.value = '';
    syncHighlight();
    applyPaneVisibility(tab);
    updateSaveButton(tab);
    showTreePlaceholder('<p class="node-meta">Structure will appear here after successful parsing.</p>');
    if (searchStatus) {
      searchStatus.textContent = tab.search.trim() ? `No matches for "${tab.search.trim()}".` : 'Showing full structure.';
    }
    updateMatchButtons();
    renderInteractionBreadcrumb(tab);
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
    tab.hideEditorForLargeFile = false;
    applyPaneVisibility(tab);
    inputBox.focus();
  });
}

if (hideTextPaneButton) {
  hideTextPaneButton.addEventListener('click', () => {
    const tab = currentTab();
    if (!tab) {
      return;
    }
    tab.hideEditorForLargeFile = true;
    applyPaneVisibility(tab);
  });
}

if (saveFileButton) {
  saveFileButton.addEventListener('click', () => {
    saveCurrentTab();
  });
}

if (beautifyButton) {
  beautifyButton.addEventListener('click', () => {
    beautifyCurrentTab();
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
      if (shouldUseAsyncSearch(tab)) {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          runAsyncSearch(tab.search, false);
        }, 250);
      } else {
        renderStructure(tab.parsedData, tab.search, true, false);
      }
    }
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const tab = currentTab();
      if (tab && tab.parsedData !== null) {
        if (shouldUseAsyncSearch(tab)) {
          const trimmed = tab.search.trim();
          const existing = getMatchCount(tab);
          if (trimmed && existing > 0) {
            const nextIndex = tab.activeMatchIndex >= 0 ? tab.activeMatchIndex + 1 : 0;
            setActiveMatch(nextIndex, trimmed, true);
            if (searchNextButton && !searchNextButton.disabled) {
              searchNextButton.focus();
            }
            return;
          }
          clearTimeout(searchDebounce);
          runAsyncSearch(tab.search, true);
        } else {
          const trimmed = tab.search.trim();
          if (trimmed && tab.matches.length > 0) {
            const nextIndex = tab.activeMatchIndex >= 0 ? tab.activeMatchIndex + 1 : 0;
            setActiveMatch(nextIndex, trimmed, true);
            if (searchNextButton && !searchNextButton.disabled) {
              searchNextButton.focus();
            }
          } else {
            renderStructure(tab.parsedData, tab.search, true, true);
          }
        }
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
    tab.asyncSearchMode = false;
    tab.asyncSearchResults = [];

    if (tab.parsedData !== null) {
      renderStructure(tab.parsedData, '', false, false);
    }

    searchInput.focus();
  });
}

if (searchPrevButton) {
  searchPrevButton.addEventListener('click', () => {
    const tab = currentTab();
    if (tab && getMatchCount(tab) > 0) {
      setActiveMatch(tab.activeMatchIndex - 1, tab.search.trim(), true);
    }
  });
}

if (searchNextButton) {
  searchNextButton.addEventListener('click', () => {
    const tab = currentTab();
    if (tab && getMatchCount(tab) > 0) {
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

if (paneResizer) {
  paneResizer.addEventListener('pointerdown', beginPaneResize);
}

window.addEventListener('pointermove', onPaneResizeMove);
window.addEventListener('pointerup', endPaneResize);
window.addEventListener('blur', endPaneResize);
window.addEventListener('resize', () => {
  updatePaneResizerVisibility(currentTab());
});

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
