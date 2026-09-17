/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/** Matches the root `<svg>` start tag, with or without a namespace prefix (`<svg:svg ...>`). */
const SVG_ROOT_START = /^<(?:[A-Za-z_][\w.-]*:)?svg[\s/>]/i;

/**
 * Walks past one prologue construct at `start` — a comment, a processing instruction (the `<?xml?>`
 * declaration included) or a declaration such as `<!DOCTYPE>`, along with any leading whitespace —
 * and returns where it ends. Returns `start` when nothing there is prologue, and `-1` when the
 * construct is never closed.
 */
function skipPrologueConstruct(svg: string, start: number): number {
    let at = start;
    while (at < svg.length && /\s/.test(svg[at])) {
        at++; // leading whitespace, and the BOM, which `\s` covers
    }
    if (svg.startsWith("<!--", at)) {
        const end = svg.indexOf("-->", at + 4);
        return end < 0 ? -1 : end + 3;
    }
    if (svg.startsWith("<?", at)) {
        const end = svg.indexOf("?>", at + 2);
        return end < 0 ? -1 : end + 2;
    }
    if (svg.startsWith("<!", at)) {
        // A DOCTYPE may carry an internal subset, whose own ">" characters don't end the
        // declaration; skip to the "]" that closes the subset before looking for it.
        let end = svg.indexOf(">", at);
        const subsetStart = svg.indexOf("[", at);
        if (subsetStart >= 0 && end >= 0 && subsetStart < end) {
            const subsetEnd = svg.indexOf("]", subsetStart);
            end = subsetEnd < 0 ? -1 : svg.indexOf(">", subsetEnd);
        }
        return end < 0 ? -1 : end + 1;
    }
    return at;
}

/**
 * Trims an SVG document down to its root `<svg>` element, or returns `undefined` when the string
 * holds no SVG at all.
 *
 * The connector-authored SVGs that reach us through `trigger-ui-metadata` routinely carry a license
 * comment ahead of their `<?xml version="1.0"?>` declaration. XML allows the declaration only as the
 * very first thing in a document, so such a file is fatally ill-formed, and every strict consumer —
 * a browser decoding `image/svg+xml`, `DOMParser`, an XML-aware icon pipeline — discards the whole
 * image on the parse error, with no console trace to explain the blank that results.
 *
 * The prologue is stepped over construct by construct rather than searched for a `<svg` needle, so
 * any number of comments, processing instructions and declarations are handled in any order, and a
 * comment that merely quotes `<svg ...>` in its text cannot be mistaken for the root element. A
 * DOCTYPE is dropped with the rest of the prologue; an internal subset defining entities the body
 * then references would not survive, which no icon we ship does.
 */
export function normalizeSvgDocument(svg?: string): string | undefined {
    if (!svg) {
        return undefined;
    }
    let at = 0;
    for (;;) {
        const next = skipPrologueConstruct(svg, at);
        if (next < 0) {
            return undefined; // unterminated prologue: the document is beyond repair
        }
        if (next === at) {
            break;
        }
        at = next;
    }
    const root = svg.slice(at);
    return SVG_ROOT_START.test(root) ? root : undefined;
}

/**
 * Turns an SVG document — an `IconDescriptor`'s `light`/`dark` member — into an `<img>`-ready data
 * URI, or `undefined` when there is no SVG to render.
 *
 * `color` tints a monochrome glyph by substituting the `currentColor` keyword, which cannot resolve
 * inside an `<img>` — the image inherits no color from the page.
 */
export function toSvgDataUri(svg?: string, color?: string): string | undefined {
    const root = normalizeSvgDocument(svg);
    if (!root) {
        return undefined;
    }
    const tinted = color ? root.replace(/currentColor/g, color) : root;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tinted)}`;
}
