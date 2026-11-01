/*
 * AUVYQ Visual Element Picker — Point-and-Click Cosmetic Filter Creator.
 *
 * Runs in ISOLATED world. Renders interactive selection UI in an isolated
 * Shadow DOM to prevent host page CSS conflicts and page script interference.
 *
 * Features:
 *   - Hover highlight bounding box.
 *   - Intelligent, stable CSS selector generation.
 *   - Prevents accidental selection of root layout containers (html, body, main).
 *   - DOM hierarchy traversal (Wider / Narrower via ArrowUp / ArrowDown).
 *   - Real-time preview mode (toggle hiding before saving).
 *   - Atomic cleanup on Cancel (Esc) with zero leftover DOM artifacts.
 *   - Dispatches SAVE_CUSTOM_RULE RPC on confirmation.
 */
(() => {
  const PICKER_FLAG = '__auvyq_picker_active__';
  if (window[PICKER_FLAG]) {
    // If already active, toggle off
    window.dispatchEvent(new CustomEvent('auvyq:picker:close'));
    return;
  }
  window[PICKER_FLAG] = true;

  const FORBIDDEN_TAGS = new Set(['HTML', 'BODY', 'HEAD', 'MAIN', 'SCRIPT', 'STYLE', 'LINK', 'META']);

  let currentTarget = null;
  let currentSelector = '';
  let isPreviewHidden = false;
  let targetHistory = [];
  let historyIndex = -1;

  // 1. Create Isolated Shadow DOM Container
  const hostDiv = document.createElement('div');
  hostDiv.id = 'auvyq-element-picker-host';
  hostDiv.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
  const shadow = hostDiv.attachShadow({ mode: 'closed' });

  // 2. Inject Styles into Shadow Root
  const style = document.createElement('style');
  style.textContent = `
    * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 0;
    }

    .auvyq-highlighter {
      position: fixed;
      pointer-events: none;
      border: 2px solid #6366F1;
      background: rgba(99, 102, 241, 0.18);
      border-radius: 4px;
      z-index: 2147483640;
      transition: top 0.05s ease-out, left 0.05s ease-out, width 0.05s ease-out, height 0.05s ease-out;
      display: none;
    }

    .auvyq-highlighter.active {
      display: block;
    }

    .auvyq-highlighter-tag {
      position: absolute;
      top: -24px;
      left: 0;
      background: #4F46E5;
      color: #FFFFFF;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 3px;
      white-space: nowrap;
      pointer-events: none;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    }

    .auvyq-toolbar {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #0F172A;
      color: #F8FAFC;
      border: 1px solid #334155;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
      border-radius: 12px;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      z-index: 2147483647;
      pointer-events: auto;
      max-width: 90vw;
      width: 580px;
      animation: auvyq-slide-up 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes auvyq-slide-up {
      from { transform: translate(-50%, 20px); opacity: 0; }
      to { transform: translate(-50%, 0); opacity: 1; }
    }

    .auvyq-toolbar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .auvyq-toolbar-title {
      font-size: 13px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
      color: #F1F5F9;
    }

    .auvyq-toolbar-badge {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: #312E81;
      color: #A5B4FC;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .auvyq-selector-preview {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #020617;
      border: 1px solid #1E293B;
      border-radius: 6px;
      padding: 6px 10px;
    }

    .auvyq-selector-input {
      background: transparent;
      border: none;
      color: #38BDF8;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      width: 100%;
      outline: none;
    }

    .auvyq-match-count {
      font-size: 11px;
      color: #94A3B8;
      white-space: nowrap;
    }

    .auvyq-toolbar-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .auvyq-button-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .auvyq-btn {
      appearance: none;
      border: 1px solid #334155;
      background: #1E293B;
      color: #E2E8F0;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: background 0.12s, border-color 0.12s;
    }

    .auvyq-btn:hover {
      background: #334155;
      border-color: #475569;
    }

    .auvyq-btn:active {
      transform: translateY(1px);
    }

    .auvyq-btn-primary {
      background: #4F46E5;
      border-color: #6366F1;
      color: #FFFFFF;
    }

    .auvyq-btn-primary:hover {
      background: #4338CA;
      border-color: #4F46E5;
    }

    .auvyq-btn-danger {
      background: #7F1D1D;
      border-color: #991B1B;
      color: #FECACA;
    }

    .auvyq-btn-danger:hover {
      background: #991B1B;
    }

    .auvyq-instructions {
      font-size: 11px;
      color: #64748B;
      text-align: center;
      margin-top: 2px;
    }
  `;
  shadow.appendChild(style);

  // 3. Highlighter DOM Elements
  const highlighter = document.createElement('div');
  highlighter.className = 'auvyq-highlighter';
  const highlighterTag = document.createElement('div');
  highlighterTag.className = 'auvyq-highlighter-tag';
  highlighter.appendChild(highlighterTag);
  shadow.appendChild(highlighter);

  // 4. Toolbar DOM Elements
  const toolbar = document.createElement('div');
  toolbar.className = 'auvyq-toolbar';
  toolbar.innerHTML = `
    <div class="auvyq-toolbar-header">
      <div class="auvyq-toolbar-title">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
        <span>AUVYQ Element Picker</span>
        <span class="auvyq-toolbar-badge">Active</span>
      </div>
      <button class="auvyq-btn auvyq-btn-danger" id="auvyq-btn-cancel">Cancel (Esc)</button>
    </div>

    <div class="auvyq-selector-preview">
      <input type="text" class="auvyq-selector-input" id="auvyq-selector-input" readonly />
      <span class="auvyq-match-count" id="auvyq-match-count">0 matches</span>
    </div>

    <div class="auvyq-toolbar-actions">
      <div class="auvyq-button-group">
        <button class="auvyq-btn" id="auvyq-btn-parent" title="Select parent container (ArrowUp)">
          <span>Wider ↑</span>
        </button>
        <button class="auvyq-btn" id="auvyq-btn-child" title="Select child element (ArrowDown)">
          <span>Narrower ↓</span>
        </button>
        <button class="auvyq-btn" id="auvyq-btn-preview" title="Preview element removal">
          <span id="auvyq-preview-text">Preview Hide</span>
        </button>
      </div>

      <button class="auvyq-btn auvyq-btn-primary" id="auvyq-btn-save" title="Save custom cosmetic rule">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        <span>Block Element</span>
      </button>
    </div>

    <div class="auvyq-instructions">
      Click any element to lock. Press <kbd>Esc</kbd> to exit, <kbd>↑</kbd> to expand, <kbd>Enter</kbd> to save.
    </div>
  `;
  shadow.appendChild(toolbar);

  document.documentElement.appendChild(hostDiv);

  const selectorInput = shadow.getElementById('auvyq-selector-input');
  const matchCount = shadow.getElementById('auvyq-match-count');
  const btnCancel = shadow.getElementById('auvyq-btn-cancel');
  const btnParent = shadow.getElementById('auvyq-btn-parent');
  const btnChild = shadow.getElementById('auvyq-btn-child');
  const btnPreview = shadow.getElementById('auvyq-btn-preview');
  const previewText = shadow.getElementById('auvyq-preview-text');
  const btnSave = shadow.getElementById('auvyq-btn-save');

  // 5. Intelligent Selector Generation
  function generateCssSelector(element) {
    if (!element || FORBIDDEN_TAGS.has(element.tagName)) return '';

    // Check if element is virtually the entire screen (>90% viewport)
    const rect = element.getBoundingClientRect();
    if (rect.width > window.innerWidth * 0.95 && rect.height > window.innerHeight * 0.9) {
      return '';
    }

    // 1. Stable, non-generated ID
    if (element.id && typeof element.id === 'string') {
      const id = element.id.trim();
      // Filter out dynamically generated random IDs
      const isDynamic = /^[0-9_-]/.test(id) ||
                        /[a-f0-9]{12,}/i.test(id) ||
                        /^(ember|react|vue|ng|jsx|guid-|uid-)/i.test(id) ||
                        id.length > 40;
      if (!isDynamic) {
        const idSelector = `#${CSS.escape(id)}`;
        if (document.querySelectorAll(idSelector).length === 1) {
          return idSelector;
        }
      }
    }

    // 2. High-signal semantic attributes
    const candidateAttrs = ['data-testid', 'data-ad-slot', 'data-ad-unit', 'data-ad', 'data-widget', 'data-component'];
    for (const attr of candidateAttrs) {
      if (element.hasAttribute(attr)) {
        const val = element.getAttribute(attr);
        const attrSelector = val ? `${element.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]` : `[${attr}]`;
        if (document.querySelectorAll(attrSelector).length === 1) {
          return attrSelector;
        }
      }
    }

    // 3. Semantic class names
    if (element.className && typeof element.className === 'string') {
      const rawClasses = element.className.trim().split(/\s+/);
      const usefulClasses = rawClasses.filter((c) => {
        if (c.length < 3 || c.length > 36) return false;
        // Ignore common utility / layout classes
        if (/^(flex|grid|col|row|p|m|w|h|bg|text|border|font|items|justify|gap|min|max)-/i.test(c)) return false;
        if (/^(active|open|closed|visible|hidden|show|hide|dark|light)$/i.test(c)) return false;
        return true;
      });

      if (usefulClasses.length > 0) {
        // Try single class
        for (const cls of usefulClasses) {
          const classSelector = `.${CSS.escape(cls)}`;
          const count = document.querySelectorAll(classSelector).length;
          if (count === 1) return classSelector;
        }

        // Try tag + compound class
        const tagWithClasses = `${element.tagName.toLowerCase()}.${usefulClasses.slice(0, 2).map((c) => CSS.escape(c)).join('.')}`;
        if (document.querySelectorAll(tagWithClasses).length === 1) {
          return tagWithClasses;
        }
      }
    }

    // 4. Hierarchical path: tag + nth-of-type with parent context
    const tag = element.tagName.toLowerCase();
    if (element.parentElement && !FORBIDDEN_TAGS.has(element.parentElement.tagName)) {
      const parentSelector = generateCssSelector(element.parentElement);
      if (parentSelector) {
        const siblings = Array.from(element.parentElement.children).filter((c) => c.tagName === element.tagName);
        if (siblings.length === 1) {
          return `${parentSelector} > ${tag}`;
        }
        const index = siblings.indexOf(element) + 1;
        return `${parentSelector} > ${tag}:nth-of-type(${index})`;
      }
    }

    return tag;
  }

  // 6. Update Highlight & Toolbar
  function updateHighlight(element) {
    if (!element || FORBIDDEN_TAGS.has(element.tagName)) {
      highlighter.classList.remove('active');
      return;
    }

    currentTarget = element;
    const rect = element.getBoundingClientRect();

    highlighter.style.top = `${rect.top}px`;
    highlighter.style.left = `${rect.left}px`;
    highlighter.style.width = `${rect.width}px`;
    highlighter.style.height = `${rect.height}px`;

    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';
    highlighterTag.textContent = `<${tag}${id}> (${Math.round(rect.width)}×${Math.round(rect.height)})`;
    highlighter.classList.add('active');

    currentSelector = generateCssSelector(element);
    selectorInput.value = currentSelector || tag;

    try {
      const matches = currentSelector ? document.querySelectorAll(currentSelector).length : 0;
      matchCount.textContent = `${matches} match${matches === 1 ? '' : 'es'}`;
    } catch {
      matchCount.textContent = 'Invalid selector';
    }
  }

  // 7. Event Handlers (Capturing phase to override host interactions)
  let isLocked = false;

  function onMouseMove(e) {
    if (isLocked) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || hostDiv.contains(el)) return;
    updateHighlight(el);
  }

  function onClick(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (hostDiv.contains(el)) return;

    e.preventDefault();
    e.stopPropagation();

    if (!el || FORBIDDEN_TAGS.has(el.tagName)) return;

    // Lock onto this element
    isLocked = true;
    targetHistory = [el];
    historyIndex = 0;
    updateHighlight(el);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectParent();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectChild();
    } else if (e.key === 'Enter' && currentSelector) {
      e.preventDefault();
      saveCustomRule();
    }
  }

  function selectParent() {
    if (!currentTarget || !currentTarget.parentElement || FORBIDDEN_TAGS.has(currentTarget.parentElement.tagName)) return;
    isLocked = true;
    const parent = currentTarget.parentElement;
    targetHistory.push(parent);
    historyIndex = targetHistory.length - 1;
    updateHighlight(parent);
  }

  function selectChild() {
    if (!currentTarget) return;
    if (historyIndex > 0) {
      historyIndex--;
      updateHighlight(targetHistory[historyIndex]);
    } else if (currentTarget.firstElementChild) {
      const child = currentTarget.firstElementChild;
      targetHistory.unshift(child);
      updateHighlight(child);
    }
  }

  function togglePreview() {
    if (!currentTarget) return;
    isPreviewHidden = !isPreviewHidden;
    if (isPreviewHidden) {
      currentTarget.style.setProperty('display', 'none', 'important');
      highlighter.classList.remove('active');
      previewText.textContent = 'Restore';
    } else {
      currentTarget.style.removeProperty('display');
      updateHighlight(currentTarget);
      previewText.textContent = 'Preview Hide';
    }
  }

  function closePicker() {
    // Restore preview state
    if (currentTarget && isPreviewHidden) {
      currentTarget.style.removeProperty('display');
    }

    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('auvyq:picker:close', closePicker);

    if (hostDiv.parentNode) {
      hostDiv.parentNode.removeChild(hostDiv);
    }
    delete window[PICKER_FLAG];
  }

  async function saveCustomRule() {
    if (!currentSelector) return;

    // Send RPC to save custom rule
    let savedSuccessfully = false;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const response = await chrome.runtime.sendMessage({
          v: 1,
          type: 'ADD_CUSTOM_RULE',
          requestId: `add_rule_${Date.now()}`,
          payload: {
            type: 'cosmetic',
            rawText: currentSelector,
            domain: location.hostname
          }
        });
        if (response && (response.success === true || response.data?.rule)) {
          savedSuccessfully = true;
        }
      }
    } catch {
      // Non-fatal
    }

    // Apply immediate local styling to prevent element reappearing only if saved successfully
    if (savedSuccessfully) {
      try {
        const hideStyle = document.createElement('style');
        hideStyle.textContent = `${currentSelector} { display: none !important; }`;
        document.head.appendChild(hideStyle);
      } catch {
        // Non-fatal
      }
    }

    closePicker();
  }

  // 8. Attach Listeners
  btnCancel.addEventListener('click', closePicker);
  btnParent.addEventListener('click', selectParent);
  btnChild.addEventListener('click', selectChild);
  btnPreview.addEventListener('click', togglePreview);
  btnSave.addEventListener('click', saveCustomRule);

  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('auvyq:picker:close', closePicker);
})();
