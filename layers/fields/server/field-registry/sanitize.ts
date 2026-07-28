import sanitizeHtml from 'sanitize-html'
import { RICHTEXT_LINK_SCHEME } from '../../app/utils/richtext-links'

export const RICHTEXT_ALLOWLIST: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark',
    'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'img', 'figure', 'figcaption', 'hr',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    '*': ['class', 'style'],
  },
  allowedStyles: {
    '*': { 'text-align': [/^(left|right|center|justify)$/] },
  },
  // `kestrel:` is the internal-link marker (`kestrel:<collection>:<id>`), resolved to a real localized
  // path at read time; it must survive sanitisation so the resolver can rewrite it.
  allowedSchemes: ['http', 'https', 'mailto', 'tel', RICHTEXT_LINK_SCHEME],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  disallowedTagsMode: 'discard',
  transformTags: {
    // Only absolute http(s) (incl. protocol-relative) links are "external" → open in a new isolated
    // tab + nofollow. Internal/relative/mailto/tel/kestrel: links keep no target/rel (a same-site link
    // must not open a new tab or be nofollowed); any author-supplied target/rel on them is dropped.
    a: (tagName, attribs) => {
      if (/^(https?:)?\/\//i.test(attribs.href ?? '')) {
        return { tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }
      }
      const { target: _t, rel: _r, ...rest } = attribs
      return { tagName, attribs: rest }
    },
  },
}

export function sanitizeRichtext(html: string): string {
  return sanitizeHtml(html, RICHTEXT_ALLOWLIST)
}
