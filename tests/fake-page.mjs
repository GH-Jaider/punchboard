// Just enough of a browser page for the deck's own modules to run in Node:
// elements that keep their children and listeners, local storage, frames on
// a timer and a WebSocket from `ws` that sends the page's Origin. No layout
// and no CSS; what is checked is what the deck sends, not how it looks.
import { WebSocket } from "ws"

class FakeClassList {
  constructor(owner) { this.owner = owner }
  get list() { return this.owner.className.split(/\s+/).filter(Boolean) }
  contains(name) { return this.list.includes(name) }
  add(name) { if (!this.contains(name)) this.owner.className = this.list.concat([name]).join(" ") }
  remove(name) { this.owner.className = this.list.filter((n) => n !== name).join(" ") }
  toggle(name, on = !this.contains(name)) { on ? this.add(name) : this.remove(name); return on }
}

export class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.className = ""
    this.textContent = ""
    this.attributes = {}
    this.listeners = {}
    this.style = { setProperty(key, value) { this[key] = value }, removeProperty(key) { delete this[key] } }
    this.classList = new FakeClassList(this)
  }
  set innerHTML(value) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this.html = value
  }
  get innerHTML() { return this.html ?? "" }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child)
    child.parentNode = null
    return child
  }
  setAttribute(key, value) { this.attributes[key] = String(value) }
  getAttribute(key) { return this.attributes[key] ?? null }
  removeAttribute(key) { delete this.attributes[key] }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener) }
  dispatch(type, fields = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...fields }
    for (const listener of this.listeners[type] ?? []) listener(event)
    return event
  }
  querySelector() { return null }
  querySelectorAll() { return [] }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true
    return false
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700 } }
  get clientWidth() { return 1000 }
  get clientHeight() { return 700 }
}

/** Installs the page as globals; `origin` is what its WebSocket says it came from. */
export function installPage({ host, origin }) {
  const ids = {}
  const byId = (id) => (ids[id] ??= new FakeElement("div"))
  const store = new Map()
  const documentListeners = {}
  const windowListeners = {}
  const body = new FakeElement("body")
  const documentElement = new FakeElement("html")
  globalThis.document = {
    body,
    documentElement,
    hidden: false,
    getElementById: byId,
    createElement: (tag) => new FakeElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, listener) { (documentListeners[type] ??= []).push(listener) }
  }
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  }
  globalThis.location = { protocol: "http:", host, hash: "", reload() {} }
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  globalThis.window = globalThis
  globalThis.innerWidth = 1000
  globalThis.innerHeight = 700
  globalThis.addEventListener = (type, listener) => { (windowListeners[type] ??= []).push(listener) }

  /** Every socket the page opened, newest last. A held socket's close event
      waits until released, as a slow network's would. */
  const sockets = []
  let holdCloses = false
  const heldCloses = []
  class PageSocket extends WebSocket {
    constructor(url) {
      super(url, { headers: { Origin: origin } })
      sockets.push(this)
    }
    set onclose(listener) {
      super.onclose = (event) => {
        if (holdCloses) heldCloses.push(() => listener.call(this, event))
        else listener.call(this, event)
      }
    }
    get onclose() { return super.onclose }
  }
  globalThis.WebSocket = PageSocket

  return {
    byId,
    sockets,
    /** While on, sockets' close events are kept back. */
    holdCloses(on) { holdCloses = on },
    /** Delivers the close events kept back so far. */
    releaseCloses() { for (const deliver of heldCloses.splice(0)) deliver() }
  }
}
