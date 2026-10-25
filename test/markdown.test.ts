/**
 * Runs the math tokenizer from web/index.html (the real page code, not a copy) under Node,
 * with the same marked and KaTeX builds the page uses.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import katex from "katex";
import { Marked } from "marked";

const page = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const script = page.split("<script>")[1]!.split("</script>")[0]!;
const mathSetup = script.slice(script.indexOf("const escapeHtml"), script.indexOf("// While a message streams"));
const marked = new Marked();
new Function("marked", "katex", mathSetup)(marked, katex);
const render = (s: string) => marked.parse(s) as string;
const formulas = (html: string) => (html.match(/class="katex"/g) ?? []).length;

describe("math in markdown", () => {
  it("renders the delimiters models actually use", () => {
    assert.equal(formulas(render("Euler $e^{i\\pi}+1=0$.")), 1);
    assert.equal(formulas(render("inline \\(a_1 * b_2\\) here")), 1);
    assert.equal(formulas(render("$$\n\\int_0^1 x\\,dx\n$$\n")), 1);
    assert.equal(formulas(render("\\[\n\\sum_{i=1}^n i\n\\]\n")), 1);
    // $$…$$ in the middle of a list item, as Gemma writes it.
    const item = render("- **Quadratic:** $$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$ done");
    assert.equal(formulas(item), 1);
    assert.match(item, /katex-display/);
  });

  it("keeps \\\\ row breaks, underscores and stars away from markdown", () => {
    const html = render("$$\\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}$$");
    assert.equal(formulas(html), 1);
    assert.doesNotMatch(html, /katex-error|\\begin/);
    assert.doesNotMatch(render("$a_1 * b_2 * c_3$"), /<em>|<strong>/);
  });

  it("leaves currency, code and unclosed dollars alone", () => {
    assert.equal(formulas(render("It costs $5 and $10 today")), 0);
    assert.equal(formulas(render("Use `$HOME` and `$x$` literally")), 0);
    assert.equal(formulas(render("```\n$$x$$\n```")), 0);
    assert.equal(formulas(render("price: $ 3 $")), 0);
  });

  it("shows invalid TeX instead of throwing", () => {
    const html = render("$$\\undefinedmacro{x}$$");
    // KaTeX (throwOnError: false) marks the bad command in the HUD error colour instead of failing.
    assert.match(html, /katex-error|math-error|color:#ff7a6b/);
    assert.match(html, /undefinedmacro/);
  });
});
