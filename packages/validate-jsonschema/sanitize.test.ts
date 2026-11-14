import { describe, expect, it } from "vitest";
import { sanitize } from "./sanitize.ts";

describe("sanitize links", () => {
  it("forces rel noopener noreferrer for target _BLANK, a named target and _parent, and removes opener", () => {
    expect(sanitize('<a href="https://ok.example" target="_BLANK" rel="opener">x</a>')).toBe('<a href="https://ok.example" target="_BLANK" rel="noopener noreferrer">x</a>');
    expect(sanitize('<a href="https://ok.example" target="win1">x</a>')).toBe('<a href="https://ok.example" target="win1" rel="noopener noreferrer">x</a>');
    expect(sanitize('<a href="https://ok.example" target="_parent" rel="opener nofollow">x</a>')).toBe('<a href="https://ok.example" target="_parent" rel="noopener noreferrer nofollow">x</a>');
  });

  it("leaves a link to _self, in any case, without a forced rel", () => {
    expect(sanitize('<a href="https://ok.example" target="_SELF">x</a>')).toBe('<a href="https://ok.example" target="_SELF">x</a>');
  });

  it("removes a data: href and a protocol-relative href", () => {
    expect(sanitize('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe("<a>x</a>");
    expect(sanitize('<a href="//evil.example/x">x</a>')).toBe("<a>x</a>");
    expect(sanitize('<a href="\\\\evil.example/x">x</a>')).toBe("<a>x</a>");
    expect(sanitize('<a href="java&#9;script:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("keeps a data: img src and a relative link", () => {
    expect(sanitize('<img src="data:image/png;base64,AAAA" alt="a">')).toBe('<img src="data:image/png;base64,AAAA" alt="a" />');
    expect(sanitize('<a href="/pages/a">x</a>')).toBe('<a href="/pages/a">x</a>');
  });

  it("removes an img src that is protocol-relative", () => {
    expect(sanitize('<img src="//evil.example/a.png">')).toBe("<img />");
  });
});
