// Runs on the parsed page, after Markdown and any raw HTML in it have become one
// tree, so it sees what the browser would get. Autoscribe's pages are written by
// an AI that reads untrusted code, and a page must not be able to run script on
// your docs site. This keeps ordinary HTML (tables, <details>, <kbd>, images) and
// removes what can execute or submit data.

const BLOCKED_ELEMENTS = new Set([
  'applet', 'base', 'button', 'embed', 'form', 'frame', 'frameset', 'iframe',
  'input', 'link', 'math', 'meta', 'noscript', 'object', 'portal', 'script',
  'select', 'style', 'svg', 'template', 'textarea',
]);

const URL_PROPERTIES = new Set([
  'action', 'background', 'cite', 'formAction', 'href', 'poster', 'src', 'xLinkHref',
]);

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

export function isSafeUrl(value) {
  // Browsers ignore control characters and spaces inside a scheme.
  const compact = String(value).replace(/[\u0000- \u007f-\u009f]/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
  return !scheme || SAFE_SCHEMES.has(scheme[1].toLowerCase());
}

function cleanProperties(properties) {
  for (const name of Object.keys(properties)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on') || lower === 'style' || lower === 'srcdoc' || lower === 'srcset') {
      delete properties[name];
    } else if (URL_PROPERTIES.has(name) && !isSafeUrl(properties[name])) {
      delete properties[name];
    }
  }
}

function clean(node) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.filter((child) => {
    if (child.type === 'raw' || child.type === 'comment') return false;
    if (child.type !== 'element') return true;
    return !BLOCKED_ELEMENTS.has(child.tagName.toLowerCase());
  });
  for (const child of node.children) {
    if (child.type === 'element') cleanProperties(child.properties ?? {});
    clean(child);
  }
}

export default function rehypeSafeHtml() {
  return (tree) => clean(tree);
}
