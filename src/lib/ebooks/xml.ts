/**
 * A small, tolerant XML reader for the two documents an EPUB needs read (container.xml and the package file). It builds
 * a plain element tree and nothing more: no DTD or entity definitions are ever honoured (so no entity-expansion
 * tricks), only the five standard entities and numeric references are decoded, and depth and node counts are
 * capped. Namespace prefixes are dropped ("dc:title" is "title"). Anything malformed just ends the parse early.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The element's own text, concatenated (children's text not included). */
  text: string;
}

const MAX_DEPTH = 64;
const MAX_NODES = 50_000;
export const MAX_XML_CHARS = 2_000_000;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return NAMED[ref] ?? m;
  });
}

const local = (qname: string) => qname.slice(qname.indexOf(":") + 1).toLowerCase();

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
/** Control characters (a NUL most of all) can't be stored as text; they mean nothing in a title, a description or a name. */
const clean = (t: string) => t.replace(CONTROL, "");

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Reads one start tag whose "<" is at `from`: its name, attributes and whether it is self-closing. Linear in the
 * length of the tag; returns null for anything that is not a well-formed tag (the caller then skips the "<").
 */
function readStartTag(xml: string, from: number): { name: string; attrs: Record<string, string>; selfClosing: boolean; end: number } | null {
  let i = from + 1;
  const nameStart = i;
  // A name never contains "<": stopping there keeps a run of them from being re-read by every tag that starts inside it.
  while (i < xml.length && !isSpace(xml[i]) && xml[i] !== ">" && xml[i] !== "/" && xml[i] !== "<") i++;
  if (i === nameStart || xml[i] === "<") return null;
  const name = local(xml.slice(nameStart, i));
  const attrs: Record<string, string> = {};
  while (i < xml.length) {
    while (i < xml.length && isSpace(xml[i])) i++;
    if (xml[i] === ">") return { name, attrs, selfClosing: false, end: i + 1 };
    if (xml[i] === "/") {
      if (xml[i + 1] === ">") return { name, attrs, selfClosing: true, end: i + 2 };
      return null;
    }
    const keyStart = i;
    while (i < xml.length && !isSpace(xml[i]) && xml[i] !== "=" && xml[i] !== ">" && xml[i] !== "/" && xml[i] !== "<") i++;
    const key = xml.slice(keyStart, i);
    while (i < xml.length && isSpace(xml[i])) i++;
    if (!key || xml[i] !== "=") return null;
    i++;
    while (i < xml.length && isSpace(xml[i])) i++;
    const quote = xml[i];
    if (quote !== '"' && quote !== "'") return null;
    const close = xml.indexOf(quote, i + 1);
    if (close < 0) return null;
    attrs[local(key)] = clean(decodeEntities(xml.slice(i + 1, close)));
    i = close + 1;
  }
  return null;
}

export function parseXml(source: string): XmlNode {
  const xml = source.length > MAX_XML_CHARS ? source.slice(0, MAX_XML_CHARS) : source;
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  const addText = (t: string) => {
    const text = clean(t);
    if (text) stack[stack.length - 1].text += text;
  };

  // One pass, each step moving forward by at least one character, every search for a terminator done with indexOf (so
  // an unterminated comment or CDATA section ends the document instead of being rescanned).
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      addText(decodeEntities(xml.slice(i)));
      break;
    }
    addText(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) break;
      addText(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) break;
      const name = local(xml.slice(lt + 2, end).trim());
      // pop to the matching open element (ignoring stray closers)
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) {
          stack.length = d;
          break;
        }
      }
      i = end + 1;
    } else {
      const tag = readStartTag(xml, lt);
      if (!tag) {
        addText("<"); // not a tag: a literal "<"
        i = lt + 1;
        continue;
      }
      if (++nodes > MAX_NODES || stack.length > MAX_DEPTH) break;
      const node: XmlNode = { name: tag.name, attrs: tag.attrs, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!tag.selfClosing) stack.push(node);
      i = tag.end;
    }
  }
  return root;
}

/** Every descendant element called `name` (namespace-free, case-insensitive), in document order. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const want = name.toLowerCase();
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === want) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export const textOf = (n: XmlNode | undefined): string => (n ? n.text.replace(/\s+/g, " ").trim() : "");
