// A small DOM for running the packaged Workbench script in node:vm. It covers
// what the page uses: elements, text, attributes, classes, inline style,
// bubbling events, focus and simple selectors. It renders nothing.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function parseSelector(selector) {
  // Split on commas and spaces outside attribute brackets and :not().
  const tokens = (text, separator) => { const out = []; let depth = 0, current = '';
    for (const char of text) { if (char === '[' || char === '(') depth++; if (char === ']' || char === ')') depth--;
      if (depth === 0 && separator.test(char)) { if (current.trim()) out.push(current.trim()); current = ''; } else current += char; }
    if (current.trim()) out.push(current.trim()); return out; };
  return tokens(selector, /,/u).map(part => tokens(part, /\s/u).map(compound => {
    const out = { tag: null, id: null, classes: [], attrs: [], not: [] };
    let rest = compound;
    rest = rest.replace(/:not\(([^)]*)\)/gu, (_, inner) => { out.not.push(parseSelector(inner)[0][0]); return ''; });
    rest = rest.replace(/\[([^\]=]+)(?:="([^"]*)")?\]/gu, (_, name, value) => { out.attrs.push([name, value]); return ''; });
    rest = rest.replace(/#([\w-]+)/gu, (_, id) => { out.id = id; return ''; });
    rest = rest.replace(/\.([\w-]+)/gu, (_, name) => { out.classes.push(name); return ''; });
    if (rest) out.tag = rest.toUpperCase();
    return out;
  }));
}
function matchesCompound(node, c) {
  if (!node || node.nodeType !== 1) return false;
  if (c.tag && node.tagName !== c.tag) return false;
  if (c.id && node.getAttribute('id') !== c.id) return false;
  for (const name of c.classes) if (!node.classList.contains(name)) return false;
  for (const [name, value] of c.attrs) if (!node.hasAttribute(name) || (value !== undefined && node.getAttribute(name) !== value)) return false;
  for (const not of c.not) if (matchesCompound(node, not)) return false;
  return true;
}
function matches(node, selector) {
  return parseSelector(selector).some(chain => {
    if (!matchesCompound(node, chain.at(-1))) return false;
    let at = node.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (at && !matchesCompound(at, chain[i])) at = at.parentNode;
      if (!at) return false;
      at = at.parentNode;
    }
    return true;
  });
}

export function createWorkbenchDom({ product = 'Product' } = {}) {
  const listeners = new Map();
  class Style {
    constructor() { this.values = new Map(); }
    setProperty(name, value) { this.values.set(name, String(value)); }
    removeProperty(name) { this.values.delete(name); }
    getPropertyValue(name) { return this.values.get(name) ?? ''; }
  }
  class Node {
    constructor(nodeType) { this.nodeType = nodeType; this.parentNode = null; this.childNodes = []; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get isConnected() { let at = this; while (at.parentNode) at = at.parentNode; return at === document.documentElement; }
    append(...nodes) { for (const node of nodes) { const child = typeof node === 'string' ? new Text(node) : node; child.remove?.(); child.parentNode = this; this.childNodes.push(child); } }
    replaceChildren(...nodes) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.append(...nodes); }
    remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter(child => child !== this); this.parentNode = null; } }
    get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(new Text(String(value))); }
  }
  class Text extends Node { constructor(text) { super(3); this.data = text; } get textContent() { return this.data; } set textContent(value) { this.data = String(value); } }
  class Element extends Node {
    constructor(tag, ns = null) {
      super(1); this.tagName = tag.toUpperCase(); this.namespaceURI = ns; this.attributes = new Map(); this.listeners = {}; this.style = new Style();
      this._value = ''; this.disabled = false; this.scrollTop = 0; this.scrollLeft = 0; this.selectionStart = 0; this.selectionEnd = 0;
      const self = this;
      this.classList = { add: (...names) => self.className = [...new Set([...self.classNames(), ...names])].join(' '),
        remove: (...names) => self.className = self.classNames().filter(name => !names.includes(name)).join(' '),
        toggle: (name, force) => { const on = force ?? !self.classNames().includes(name); if (on) self.classList.add(name); else self.classList.remove(name); return on; },
        contains: name => self.classNames().includes(name) };
    }
    classNames() { return (this.getAttribute('class') ?? '').split(/\s+/u).filter(Boolean); }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.setAttribute('class', value); }
    get id() { return this.getAttribute('id') ?? ''; }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get value() { return this._value; }
    set value(value) { this._value = String(value); this.selectionStart = this.selectionEnd = this._value.length; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] ?? []).filter(item => item !== fn); }
    querySelectorAll(selector) { const out = []; const walk = node => { for (const child of node.childNodes) { if (child.nodeType === 1) { if (matches(child, selector)) out.push(child); walk(child); } } }; walk(this); return out; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { for (let at = this; at && at.nodeType === 1; at = at.parentNode) if (matches(at, selector)) return at; return null; }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = document.body; }
    select() {}
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    scrollIntoView() { document.revealed.push(this); }
    click() { return dispatch(this, 'click'); }
  }
  // Bubbling dispatch with stopPropagation; document listeners run last.
  async function dispatch(target, type, extra = {}) {
    let stopped = false;
    const event = { type, target, currentTarget: target, stopPropagation: () => { stopped = true; }, preventDefault() {}, ...extra };
    const results = [];
    for (let at = target; at && !stopped; at = at.parentNode) {
      if (at.disabled && type === 'click' && at === target) return;
      event.currentTarget = at;
      for (const fn of at.listeners?.[type] ?? []) results.push(fn(event));
    }
    if (!stopped) for (const fn of listeners.get(type) ?? []) results.push(fn(event));
    await Promise.all(results.map(value => Promise.resolve(value).catch(() => {})));
  }
  const document = { revealed: [], activeElement: null,
    createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag, ns), createTextNode: text => new Text(String(text)),
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    querySelectorAll: selector => document.documentElement.querySelectorAll(selector), querySelector: selector => document.documentElement.querySelector(selector),
    execCommand: () => true };
  document.documentElement = new Element('html'); document.documentElement.setAttribute('data-product', product);
  document.body = new Element('body'); document.documentElement.append(document.body); document.activeElement = document.body;
  const node = (tag, id, attrs = {}) => { const el = new Element(tag); el.setAttribute('id', id); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
  const pairing = node('div', 'pairing'), card = new Element('div');
  card.append(node('div', 'pair-status'), node('button', 'pair-copy', { hidden: '' }), node('span', 'pair-copied'), node('p', 'pair-instructions', { hidden: '' }), node('button', 'pair-again'));
  pairing.append(card);
  document.body.append(pairing, node('div', 'app', { hidden: '' }));
  return { document, dispatch, Element };
}

/** Load the packaged page script into a fresh context whose fetch reaches the
 * given engine handlers in this process, as the loopback server would. */
export function loadWorkbenchPage(handlers, { dark = false, product = 'Product', innerWidth } = {}) {
  const { document, dispatch } = createWorkbenchDom({ product });
  const copied = [], calls = [], windowListeners = new Map();
  const media = { matches: dark, listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
  const respond = async (path, body) => {
    if (path === '/pair/start') return { ok: true, result: { code: 'TEST-CODE', nonce: 'nonce' } };
    if (path === '/pair/complete') return { ok: true, result: { paired: true, token: 'token' } };
    calls.push(body.action);
    const entry = handlers[body.action];
    if (!entry) return { ok: false, error: { code: 'WORKBENCH_ACTION_UNKNOWN', next_action: 'Unknown.' } };
    try { return { ok: true, result: JSON.parse(JSON.stringify(await (entry.run ?? entry)(body.params, {}))) }; }
    catch (error) { return { ok: false, error: { code: error.code ?? 'WORKBENCH_ACTION_FAILED', next_action: error.nextAction ?? 'Failed.' } }; }
  };
  const window = { addEventListener(type, fn) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(fn); },
    removeEventListener(type, fn) { windowListeners.set(type, (windowListeners.get(type) ?? []).filter(item => item !== fn)); } };
  const context = createContext({ document, window, innerWidth,
    navigator: { clipboard: { writeText: async text => { copied.push(text); } } },
    matchMedia: () => media, setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms === 1200 ? 0 : ms); timer.unref?.(); return timer; }, clearTimeout,
    fetch: async (path, options) => { const result = await respond(path, JSON.parse(options.body)); return { json: async () => result }; } });
  runInContext(readFileSync(new URL('../../lib/workbench/workbench.js', import.meta.url), 'utf8'), context);
  const settle = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
  const q = selector => document.querySelector(selector), all = selector => document.querySelectorAll(selector);
  return { document, context, copied, calls, media, settle, q, all,
    // A pointer click: mousedown, then click, as a browser delivers them. When
    // the mousedown removed the pressed control from the page, the browser
    // delivers no click to it, so neither does this.
    async click(target) { const node = typeof target === 'string' ? q(target) : target; if (!node) throw new Error(`Nothing matches ${target}`);
      await dispatch(node, 'mousedown'); if (node.isConnected) await dispatch(node, 'click'); await settle(); },
    async key(key, target = document.body, extra = {}) { await dispatch(target, 'keydown', { key, ...extra }); await settle(); },
    // The operator comes back to the tab: it becomes visible and the window regains focus.
    async returnToTab() { document.visibilityState = 'visible'; await dispatch(document.body, 'visibilitychange');
      for (const fn of windowListeners.get('focus') ?? []) await fn({ type: 'focus' }); await settle(); },
    async mousedown(target) { await dispatch(target, 'mousedown'); await settle(); },
    // The window is resized to a new width.
    async resize(width) { context.innerWidth = width; for (const fn of windowListeners.get('resize') ?? []) await fn({ type: 'resize' }); await settle(); },
    // A mouse drag: press on the target, move by dx, release.
    async drag(target, dx) { await dispatch(target, 'mousedown', { clientX: 0 });
      for (const fn of windowListeners.get('mousemove') ?? []) await fn({ type: 'mousemove', clientX: dx });
      for (const fn of windowListeners.get('mouseup') ?? []) await fn({ type: 'mouseup', clientX: dx }); await settle(); },
    async type(selector, text) { const node = q(selector); node.focus(); node.value = text; await dispatch(node, 'input'); },
    text: selector => q(selector)?.textContent ?? null };
}
