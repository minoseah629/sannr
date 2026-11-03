// Shared terminal styling: a small ink-and-lime stamp, never a dependency or
// an ANSI wrapper around machine output. Call only from human output paths.
export function terminalTheme({ stream = process.stdout, env = process.env } = {}) {
  const color = Boolean(stream.isTTY) && env.TERM !== "dumb" && !("NO_COLOR" in env);
  const trueColor = color && (stream.getColorDepth?.(env) ?? 4) >= 24;
  const wrap = (code) => (text) => color ? `\x1b[${code}m${text}\x1b[0m` : String(text);
  return {
    columns: stream.columns || 80,
    stamp: wrap(trueColor ? "1;30;48;2;200;242;36" : "1;30;103"),
    accent: wrap(trueColor ? "1;38;2;200;242;36" : "1;33"),
    alarm: wrap(trueColor ? "1;30;48;2;255;74;61" : "1;30;101"),
    bold: wrap("1"),
    muted: wrap("2"),
    warning: wrap("1;33"),
    high: wrap("1;31"),
    link: (url) => {
      const label = terminalText(url);
      // Keep the URL visible for terminals without OSC 8 support. Never put
      // untrusted control characters or a command/file scheme in an escape.
      if (!color || /[\x00-\x20\x7f-\x9f]/.test(url) || !/^https?:\/\//.test(url)) return label;
      return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
    },
  };
}

// A path is data, even when it contains an escape or a line break. Keep it on
// one line without letting repository-controlled bytes issue terminal commands.
export function terminalText(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
