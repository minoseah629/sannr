// Shared offline report palette: the site's black/lime and cream/ink themes.
// Native radio state plus :has() keeps the exported report script-free. No
// preference is written to disk or browser storage; reopening uses its default.
const DARK = "color-scheme:dark;--bg:#0b0b0b;--paper:#efeee9;--ink:#efeee9;--card:#0b0b0b;--soft:#b8b7b0;--muted:#85847c;--line:rgba(239,238,233,.22);--line-strong:#efeee9;--faint:rgba(239,238,233,.07);--panel-bg:rgba(239,238,233,.025);--grain-dot:rgba(239,238,233,.08);--accent:#c8f224;--accent-text:#c8f224;--on-accent:#0b0b0b;--frame:#c8f224;--lime:#c8f224;--red:#ff4a3d;--high:#ff4a3d;--med:#c8f224;--low:#b8b7b0;--alert-bg:#ff4a3d;--on-alert:#0b0b0b";
const LIGHT = "color-scheme:light;--bg:#fbfaf5;--paper:#0b0b0b;--ink:#0b0b0b;--card:#fefdfa;--soft:#3a3934;--muted:#57564f;--line:rgba(11,11,11,.2);--line-strong:#0b0b0b;--faint:rgba(11,11,11,.07);--panel-bg:rgba(11,11,11,.025);--grain-dot:rgba(11,11,11,.08);--accent:#c8f224;--accent-text:#4a5c05;--on-accent:#0b0b0b;--frame:#0b0b0b;--lime:#c8f224;--red:#b32920;--high:#b32920;--med:#4a5c05;--low:#57564f;--alert-bg:#ff4a3d;--on-alert:#0b0b0b";
const choices = Object.freeze(['system', 'light', 'dark']);
const validated = theme => {
  if (!choices.includes(theme)) throw new TypeError('Unknown report theme.');
  return theme;
};

export function reportThemeCss(defaultTheme = 'dark') {
  validated(defaultTheme);
  return `:root{${defaultTheme === 'dark' ? DARK : LIGHT}}
:root:has(#report-theme-system:checked){${LIGHT}}
@media(prefers-color-scheme:dark){:root:has(#report-theme-system:checked){${DARK}}}
:root:has(#report-theme-light:checked){${LIGHT}}
:root:has(#report-theme-dark:checked){${DARK}}
.report-theme{display:flex;flex-wrap:wrap;gap:.4rem .75rem;min-width:0;margin:0 0 1.25rem;padding:.35rem .65rem .65rem;border:1px solid var(--line);color:var(--ink);background:var(--card);font:normal .85rem/1.4 system-ui,sans-serif}
.report-theme legend{padding:0 .3rem;font-size:.8rem;color:var(--muted)}
.report-theme-choice{display:inline-flex;align-items:center;gap:.35rem;min-width:0}
.report-theme input{width:1rem;height:1rem;margin:0;accent-color:var(--accent-text);flex:none}
.report-theme label{display:inline-flex;align-items:center;min-height:2rem;padding:.15rem .5rem;border:1px solid transparent;cursor:pointer;overflow-wrap:anywhere}
.report-theme input:checked+label{background:var(--accent);color:var(--on-accent);border-color:var(--frame)}
.report-theme input:focus-visible{outline:2px solid var(--accent-text);outline-offset:3px}
.report-theme input:focus-visible+label{outline:2px solid var(--accent-text);outline-offset:2px}`;
}

export function renderReportTheme(defaultTheme = 'dark') {
  validated(defaultTheme);
  return '<fieldset class="report-theme"><legend>Theme</legend>' + choices.map(theme =>
    `<span class="report-theme-choice"><input type="radio" name="report-theme" id="report-theme-${theme}"${theme === defaultTheme ? ' checked' : ''}><label for="report-theme-${theme}">${theme[0].toUpperCase()}${theme.slice(1)}</label></span>`).join('') + '</fieldset>';
}
