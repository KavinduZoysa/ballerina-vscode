/*
 *  Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com)
 *
 *  WSO2 LLC. licenses this file to you under the Apache License,
 *  Version 2.0 (the "License"); you may not use this file except
 *  in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

import { toIconDescriptor } from "../interfaces/extended-lang-client";
import { normalizeSvgDocument, toSvgDataUri } from "../utils/icon-utils";

const decode = (dataUri: string | undefined) =>
    decodeURIComponent((dataUri ?? "").replace("data:image/svg+xml;charset=utf-8,", ""));

/** The shape every `trigger-ui-metadata` icon arrives in: a license comment ahead of the XML
 * declaration, which makes the document fatally ill-formed for an XML parser. */
const withPrologue = (body: string) => [
    "<!--",
    " ~ Copyright (c) 2026, WSO2 LLC. All Rights Reserved.",
    "-->",
    '<?xml version="1.0" encoding="UTF-8"?>',
    body,
].join("\n");

describe("normalizeSvgDocument", () => {
    const root = '<svg xmlns="http://www.w3.org/2000/svg" fill="black"/>';

    it.each([
        ["the real ftp payload: license comment ahead of the declaration", `<!--\n ~ Copyright (c) 2026, WSO2 LLC.\n-->\n<?xml version="1.0" encoding="UTF-8"?>\n${root}`],
        ["declaration first, comment after", `<?xml version="1.0"?>\n<!-- c -->\n${root}`],
        ["a public DOCTYPE", `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n${root}`],
        ["a DOCTYPE whose internal subset contains '>'", `<!DOCTYPE svg [<!ENTITY a "b"> ]>\n${root}`],
        ["a byte-order mark and indentation", `\ufeff\n  ${root}`],
        ["comments and processing instructions interleaved", `<!--a--><!--b--><?xml version="1.0"?><?xml-stylesheet href="x"?><!--c-->${root}`],
        ["a comment that quotes an <svg ...> tag in its text", `<!-- e.g. <svg width="1"/> -->\n<?xml version="1.0"?>\n${root}`],
        ["no prologue at all", root],
    ])("strips %s", (_label, svg) => {
        expect(normalizeSvgDocument(svg)).toBe(root);
    });

    it("keeps a namespace-prefixed root element", () => {
        const prefixed = '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>';

        expect(normalizeSvgDocument(`<!-- c -->\n${prefixed}`)).toBe(prefixed);
    });

    it.each([
        ["an unterminated comment", "<!-- oops\n<svg/>"],
        ["markup that is not an SVG", "<html><body/></html>"],
        ["an element merely starting with 'svg'", "<svgfoo/>"],
        ["a prologue with no root element", "<!-- just a comment -->"],
        ["whitespace only", "   \n  "],
        ["an empty string", ""],
        ["nothing", undefined],
    ])("returns undefined for %s", (_label, svg) => {
        expect(normalizeSvgDocument(svg)).toBeUndefined();
    });
});

describe("toSvgDataUri", () => {
    it("drops the prologue a connector SVG carries ahead of its root element", () => {
        const svg = withPrologue('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0,0"/></svg>');

        const decoded = decode(toSvgDataUri(svg));

        expect(decoded.startsWith("<svg ")).toBe(true);
        expect(decoded).not.toContain("<?xml");
        expect(decoded).not.toContain("Copyright");
    });

    it("keeps a well-formed SVG intact", () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0,0"/></svg>';

        expect(decode(toSvgDataUri(svg))).toBe(svg);
    });

    it("substitutes currentColor, which cannot resolve inside an <img>", () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="currentColor"/>';

        expect(decode(toSvgDataUri(svg, "#f60"))).toBe(
            '<svg xmlns="http://www.w3.org/2000/svg" fill="#f60" stroke="#f60"/>'
        );
    });

    it("returns undefined when there is no SVG to render", () => {
        expect(toSvgDataUri(undefined)).toBeUndefined();
        expect(toSvgDataUri("")).toBeUndefined();
        expect(toSvgDataUri("not an svg at all")).toBeUndefined();
    });
});

describe("toIconDescriptor", () => {
    const light = '<svg xmlns="http://www.w3.org/2000/svg" fill="black"/>';
    const dark = '<svg xmlns="http://www.w3.org/2000/svg" fill="white"/>';

    it("normalizes the theme SVG pair so consumers never see the prologue", () => {
        const descriptor = toIconDescriptor({
            url: "https://example.com/ftp.png",
            source: "trigger-ui-metadata",
            light: withPrologue(light),
            dark: withPrologue(dark),
        });

        expect(descriptor).toEqual({
            url: "https://example.com/ftp.png",
            source: "trigger-ui-metadata",
            light,
            dark,
        });
    });

    it("drops a document with no root element, leaving url/glyph to take over", () => {
        const descriptor = toIconDescriptor({ url: "https://example.com/ftp.png", light: "", dark });

        expect(descriptor?.light).toBeUndefined();
        expect(descriptor?.dark).toBe(dark);
    });

    it("reads a bare string as a legacy url", () => {
        expect(toIconDescriptor("https://example.com/ftp.png")).toEqual({ url: "https://example.com/ftp.png" });
    });

    it("passes a descriptor with no theme SVGs through untouched", () => {
        const descriptor = { glyph: "bi-ftp", color: "#f60" };

        expect(toIconDescriptor(descriptor)).toBe(descriptor);
    });

    it("returns undefined for a missing icon", () => {
        expect(toIconDescriptor(undefined)).toBeUndefined();
    });
});
