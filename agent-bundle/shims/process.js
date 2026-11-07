/** 包内用的 process 替身（只在打包产物内部生效，不挂到 window） */
export const process = {
  env: { NODE_ENV: "production", LANGSMITH_TRACING: "false", LANGCHAIN_TRACING_V2: "false" },
  versions: {},
  version: "",
  platform: "browser",
  browser: true,
  cwd: () => "/",
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  emitWarning: () => {},
  on: () => {},
  once: () => {},
  off: () => {}
};
