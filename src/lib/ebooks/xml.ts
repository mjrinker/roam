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

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?][^\s/>]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(source: string): XmlNode {
  const xml = source.length > MAX_XML_CHARS ? source.slice(0, MAX_XML_CHARS) : source;
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let last = 0;
  TOKEN.lastIndex = 0;
  const addText = (t: string) => {
    // Control characters (a NUL most of all) can't be stored as text; they mean nothing in a title or a description.
    const clean = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    if (clean) stack[stack.length - 1].text += clean;
  };
  for (let m = TOKEN.exec(xml); m; m = TOKEN.exec(xml)) {
    addText(decodeEntities(xml.slice(last, m.index)));
    last = TOKEN.lastIndex;
    if (m[1] !== undefined) addText(m[1]); // CDATA: taken literally
    else if (m[2] !== undefined) {
      // closing tag: pop to the matching open element (ignoring stray closers)
      const name = local(m[2]);
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
    } else if (m[3] !== undefined) {
      if (++nodes > MAX_NODES || stack.length > MAX_DEPTH) break;
      const attrs: Record<string, string> = {};
      ATTR.lastIndex = 0;
      for (let a = ATTR.exec(m[4] ?? ""); a; a = ATTR.exec(m[4] ?? "")) attrs[local(a[1])] = decodeEntities(a[2] ?? a[3] ?? "");
      const node: XmlNode = { name: local(m[3]), attrs, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  addText(decodeEntities(xml.slice(last)));
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
