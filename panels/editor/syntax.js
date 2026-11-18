// What Obsidian adds to Markdown, as extensions of the Lezer Markdown parser, so the editor's syntax tree knows it:
// `[[links]]` and `![[embeds]]`, `==highlights==`, `$math$` and `$$` blocks, `#tags`, `%%comments%%` and the
// properties block (YAML between `---` lines at the very top). Code spans and code blocks win over all of these, as
// in the reading view (shared/markdown.js).
import { tags } from "../../vendor/editor.js";

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
const space = (s) => /\s|^$/.test(s);
const punct = (s) => /[\p{P}\p{S}]/u.test(s);

/** `[[Target#Heading|label]]` and `![[file.png|caption|400]]`: one line, no brackets inside. */
const WikiLink = {
  defineNodes: [
    { name: "WikiLink", style: tags.link },
    { name: "WikiEmbed", style: tags.link },
    { name: "WikiMark", style: tags.processingInstruction },
    { name: "WikiTarget" },
  ],
  parseInline: [{
    name: "WikiLink",
    parse(cx, next, pos) {
      const embed = next === 33 /* ! */;
      const open = embed ? pos + 1 : pos;
      if (cx.char(open) !== 91 || cx.char(open + 1) !== 91) return -1;
      const start = open + 2;
      for (let i = start; i < cx.end; i++) {
        const c = cx.char(i);
        if (c === 10 || c === 91) return -1;
        if (c === 93) {
          if (cx.char(i + 1) !== 93 || i === start) return -1;
          return cx.addElement(cx.elt(embed ? "WikiEmbed" : "WikiLink", pos, i + 2, [
            cx.elt("WikiMark", pos, start), cx.elt("WikiTarget", start, i), cx.elt("WikiMark", i, i + 2),
          ]));
        }
      }
      return -1;
    },
    before: "Link",
  }],
};

/** `==text==`, delimited like GFM's `~~`. */
const Highlight = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": tags.special(tags.content) } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [{
    name: "Highlight",
    parse(cx, next, pos) {
      if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
      const before = cx.slice(pos - 1, pos);
      const after = cx.slice(pos + 2, pos + 3);
      const sB = space(before), sA = space(after), pB = punct(before), pA = punct(after);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sA && (!pA || sB || pB), !sB && (!pB || sA || pA));
    },
    after: "Emphasis",
  }],
};

/** `$x^2$`: no space just inside the dollars, no digit right after the closing one (so "$5 and $6" stays text). */
const InlineMath = {
  defineNodes: [{ name: "InlineMath", style: tags.special(tags.string) }, { name: "MathMark", style: tags.processingInstruction }],
  parseInline: [{
    name: "InlineMath",
    parse(cx, next, pos) {
      if (next !== 36 || cx.char(pos + 1) === 36 || cx.char(pos - 1) === 92) return -1;
      const first = cx.char(pos + 1);
      if (first === 32 || first === 9 || first === 10 || first === -1) return -1;
      for (let i = pos + 2; i < cx.end; i++) {
        const c = cx.char(i);
        if (c === 10) return -1;
        if (c === 36 && cx.char(i - 1) !== 92) {
          const prev = cx.char(i - 1);
          const after = cx.char(i + 1);
          if (prev === 32 || prev === 9 || (after >= 48 && after <= 57)) return -1;
          return cx.addElement(cx.elt("InlineMath", pos, i + 1,
            [cx.elt("MathMark", pos, pos + 1), cx.elt("MathMark", i, i + 1)]));
        }
      }
      return -1;
    },
    before: "Emphasis",
  }],
};

/** `#tag`, `#nested/tag` at a word start (as links.js reads them): a letter or `_` first. */
const HashTag = {
  defineNodes: [{ name: "HashTag", style: tags.labelName }],
  parseInline: [{
    name: "HashTag",
    parse(cx, next, pos) {
      if (next !== 35) return -1;
      const before = cx.slice(pos - 1, pos);
      if (before && !/[\s(,;]/.test(before)) return -1;
      let i = pos + 1;
      const first = cx.slice(i, i + 2);
      if (!/^[\p{L}_]/u.test(first)) return -1;
      while (i < cx.end && /[\p{L}\p{N}_\-/]/u.test(String.fromCodePoint(cx.char(i)))) i++;
      return cx.addElement(cx.elt("HashTag", pos, i));
    },
    before: "Emphasis",
  }],
};

/** `%%a comment%%` (on one line): kept in the text, not shown in the reading view. */
const Comment = {
  defineNodes: [{ name: "WikiComment", style: tags.comment }],
  parseInline: [{
    name: "WikiComment",
    parse(cx, next, pos) {
      if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
      for (let i = pos + 2; i < cx.end - 1; i++) {
        if (cx.char(i) === 10) return -1;
        if (cx.char(i) === 37 && cx.char(i + 1) === 37) return cx.addElement(cx.elt("WikiComment", pos, i + 2));
      }
      return -1;
    },
    before: "Emphasis",
  }],
};

const atTop = (cx) => cx.parentType().name === "Document";

/** A `$$` line, the math, and the closing `$$` line (top level only). */
const BlockMath = {
  defineNodes: [{ name: "BlockMath", block: true, style: tags.special(tags.string) }, { name: "BlockMathMark",
    style: tags.processingInstruction }],
  parseBlock: [{
    name: "BlockMath",
    parse(cx, line) {
      if (!atTop(cx) || !/^ {0,3}\$\$\s*$/.test(line.text)) return false;
      const from = cx.lineStart;
      const marks = [cx.elt("BlockMathMark", from + line.pos, from + line.pos + 2)];
      while (cx.nextLine()) {
        if (/^ {0,3}\$\$\s*$/.test(line.text)) {
          marks.push(cx.elt("BlockMathMark", cx.lineStart + line.pos, cx.lineStart + line.pos + 2));
          cx.nextLine();
          break;
        }
      }
      cx.addElement(cx.elt("BlockMath", from, cx.prevLineEnd(), marks));
      return true;
    },
    before: "FencedCode",
  }],
};

/** The properties block: `---` on the first line up to the next `---` (or `...`) line. */
const Frontmatter = {
  defineNodes: [{ name: "Frontmatter", block: true, style: tags.meta }, { name: "FrontmatterMark",
    style: tags.processingInstruction }],
  parseBlock: [{
    name: "Frontmatter",
    parse(cx, line) {
      if (cx.lineStart !== 0 || !atTop(cx) || !/^---\s*$/.test(line.text)) return false;
      // Only a closed block counts (as shared/frontmatter.js reads it): an unclosed `---` at the top stays a rule.
      // The parser can't look further than one line, so the input is read directly (an internal field; falls back to
      // "closed" when it is missing).
      const input = cx.input;
      if (input?.read) {
        const head = input.read(0, Math.min(input.length, 200000));
        if (!/\n(---|\.\.\.)[ \t]*(\n|$)/.test(head)) return false;
      }
      const marks = [cx.elt("FrontmatterMark", 0, 3)];
      while (cx.nextLine()) {
        if (/^(---|\.\.\.)[ \t]*$/.test(line.text)) {
          marks.push(cx.elt("FrontmatterMark", cx.lineStart, cx.lineStart + 3));
          cx.nextLine();
          break;
        }
      }
      cx.addElement(cx.elt("Frontmatter", 0, cx.prevLineEnd(), marks));
      return true;
    },
    before: "HorizontalRule",
  }],
};

export const WIKI_SYNTAX = [WikiLink, Highlight, InlineMath, HashTag, Comment, BlockMath, Frontmatter];
