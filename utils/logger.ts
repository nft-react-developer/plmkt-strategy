const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[level] ?? 1;

function fmt(lvl: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${lvl.toUpperCase()}] ${msg}`;
  if (extra !== undefined) {
    const detail = extra instanceof Error ? extra.stack ?? extra.message : JSON.stringify(extra);
    return `${base}\n${detail}`;
  }
  return base;
}

export const logger = {
  debug: (msg: string, extra?: unknown) => { if (currentLevel <= 0) console.debug(fmt('debug', msg, extra)); },
  info:  (msg: string, extra?: unknown) => { if (currentLevel <= 1) console.info(fmt('info', msg, extra));  },
  warn:  (msg: string, extra?: unknown) => { if (currentLevel <= 2) console.warn(fmt('warn', msg, extra));  },
  error: (msg: string, extra?: unknown) => { if (currentLevel <= 3) console.error(fmt('error', msg, extra)); },
};