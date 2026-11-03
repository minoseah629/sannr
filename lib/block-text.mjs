// Text that enters the managed pointer block comes from places the product
// does not control: notes written by any agent or human, operation keys copied
// from a third party's contract, tool names declared by an MCP server, keys
// from a host's registration. The block is a file the agent reads as
// instructions and it is delimited by HTML comments, so a comment token inside
// a note closes the block early and plants top-level markdown in a committed
// file (and the next regeneration reads the file as edited, forever), while a
// newline turns a bullet into a heading. Every foreign string is flattened to
// one line, stripped of control characters, has its comment markup made
// visible, and is bounded — at render time, so hand-edited and imported
// knowledge files are covered, not only the CLI's own `note` command.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Longest note the block carries: enough for a long safe URL, small enough that a
 * poisoned knowledge file cannot turn the block into an unbounded prompt. */
export const BLOCK_TEXT_MAX = 8192;

export function blockText(value, { max = BLOCK_TEXT_MAX } = {}) {
  let text = String(value ?? "").replace(CONTROL, " ").replace(/\s{2,}/g, " ").trim();
  text = text.replace(/<!--/g, "[!--").replace(/-->/g, "--]");
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

/** For inline code spans: the same flattening, plus no backtick can close the span. */
export function blockCode(value, { max = 200 } = {}) {
  return blockText(value, { max }).replace(/`/g, "'");
}

export function hasCommentMarkup(value) {
  return /<!--|-->/.test(String(value ?? ""));
}

/** The last line of defence: a rendered body that still carries a delimiter is
 * never written. Sanitising should make this unreachable; if it fires, the
 * render is refused by name instead of committing a broken block. */
export function assertManagedBody(body, begin, end) {
  if (body.includes(begin) || body.includes(end)) {
    const error = new Error("A rendered pointer block would contain its own delimiter; refusing to write it.");
    error.code = "POINTER_RENDER_UNSAFE";
    throw error;
  }
  return body;
}
