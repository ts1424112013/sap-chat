/**
 * 浏览器里替代 node:async_hooks。只有 langsmith 的跟踪会用到（灵犀里跟踪关闭）。
 * 同步作用域实现：run() 期间 getStore() 有值；跨 await 不保证（LangChain 在浏览器里本就如此）。
 */
export class AsyncLocalStorage {
  constructor() { this._store = undefined; }
  getStore() { return this._store; }
  run(store, fn, ...args) {
    const prev = this._store;
    this._store = store;
    try { return fn(...args); } finally { this._store = prev; }
  }
  enterWith(store) { this._store = store; }
  exit(fn, ...args) { return this.run(undefined, fn, ...args); }
  disable() { this._store = undefined; }
}
export default { AsyncLocalStorage };
