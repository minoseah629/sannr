// Human install copy. Keep these renderers outside instruction and JSON paths.
import { stripVTControlCharacters } from "node:util";
import { PRODUCT } from "./brand.mjs";
import { LAYOUT } from "./layout.mjs";

const productTitle = PRODUCT[0].toUpperCase() + PRODUCT.slice(1);
export const CONNECT_VOICE = `${productTitle} here. I live in your repo, there's no server on my end, and I haven't phoned anyone yet.`;

export function installPointerSentence() {
  return `${productTitle} wrote the lines below for your coding agent; the human version is that this repo now keeps what it learns about its APIs in ${LAYOUT.directory}/, next to the code, where anyone who reads files can read it.`;
}

export function doctorSummaryLine(failed, warnings) {
  return (failed ? `${failed} check${failed === 1 ? "" : "s"} FAILED`
    : "Nothing's on fire: all checks passed")
    + (warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "") + ".";
}

export const DOCTOR_ZEN_TEXT_MAX = 240;

/** Only the default public onboarding koan is human output. Arbitrary API
 * bodies, errors and configured/override probes never use this renderer. */
export function renderDoctorZen(body, { targetSource, method, url, status } = {}) {
  if (targetSource !== "default" || method !== "GET"
    || url !== "https://api.github.com/zen" || status !== 200 || typeof body !== "string") return null;
  const clean = stripVTControlCharacters(body)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return null;
  // Bound the printable representation, not only the input. Escaped quotes
  // keep an embedded quotation inside the attributed third-party response.
  let quoted = "";
  for (const char of clean) {
    const shown = char === '"' || char === "\\" ? `\\${char}` : char;
    if (quoted.length + shown.length > DOCTOR_ZEN_TEXT_MAX - 1) {
      quoted += "…";
      break;
    }
    quoted += shown;
  }
  const period = quoted.endsWith(".") ? "" : ".";
  return `I asked GitHub for a fortune and it said "${quoted}"${period} I can't vouch for the advice, only for the round trip.`;
}
