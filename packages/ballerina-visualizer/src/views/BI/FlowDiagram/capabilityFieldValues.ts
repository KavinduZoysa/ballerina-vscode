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

/**
 * A durable agent capability's form is a fresh template seeded with the entry's values, which the
 * language server hands over as source. A field offering both a text box and an expression editor
 * has to be put into the right one here: seeding the value alone leaves the template's mode, so a
 * reference lands in the text box and is written back as a literal of the same spelling.
 */

/** A form field's declared type, of which one is selected. */
interface FieldType {
    fieldType?: string;
    selected?: boolean;
}

/** The part of a form property this module reads and writes. */
export interface SeedableProperty {
    value?: unknown;
    types?: FieldType[];
}

// The modes that hold text rather than source. A doc box is one of them: it is a single mode, but a
// literal still belongs in it decoded.
const TEXT_MODES = ["TEXT", "DOC_TEXT"];
const EXPRESSION = "EXPRESSION";

/** Whether the source is a plain string literal, the one shape a text box can hold. */
function stringLiteral(source: string): boolean {
    if (source.length < 2 || !source.startsWith('"') || !source.endsWith('"')) {
        return false;
    }
    // A closing quote that is escaped does not end the literal, so `"a\" + b` is an expression.
    let escaped = false;
    for (let i = 1; i < source.length - 1; i++) {
        if (escaped) {
            escaped = false;
        } else if (source[i] === "\\") {
            escaped = true;
        } else if (source[i] === '"') {
            return false;
        }
    }
    return !escaped;
}

/**
 * The text a string literal denotes, with the escapes it carries resolved. Read in one pass: an
 * escaped backslash consumes the character after it, so `"C:\\new"` is a path and not a line break.
 */
function literalText(source: string): string {
    const body = source.slice(1, -1);
    let text = "";
    for (let i = 0; i < body.length; i++) {
        if (body[i] !== "\\" || i === body.length - 1) {
            text += body[i];
            continue;
        }
        const escaped = body[++i];
        if (escaped === "u" && body[i + 1] === "{") {
            // `\u{1F600}`, the only escape with a body. The language server decodes it too, and a
            // literal must not read differently depending on which side looked at it.
            const close = body.indexOf("}", i + 2);
            const code = close === -1 ? NaN : Number.parseInt(body.slice(i + 2, close), 16);
            if (close !== -1 && Number.isFinite(code)) {
                text += String.fromCodePoint(code);
                i = close;
                continue;
            }
        }
        switch (escaped) {
            case "n": text += "\n"; break;
            case "t": text += "\t"; break;
            case "r": text += "\r"; break;
            default: text += escaped; break;
        }
    }
    return text;
}

/**
 * The text a hydrated value reads as: a string literal decoded, anything else as it stands. For
 * showing a value rather than editing it, such as the panel's subtitle.
 *
 * @param source the value as it stands in the declaration
 * @return the text to show
 */
export function capabilityValueText(source: string | undefined): string | undefined {
    if (!source) {
        return source;
    }
    return stringLiteral(source) ? literalText(source) : source;
}

/**
 * Seeds one property from the source the language server hydrated, choosing the field's mode with
 * it: a string literal fills the text box, anything else is an expression.
 *
 * @param property the form property to seed, edited in place
 * @param source   the value as it stands in the declaration
 */
export function seedCapabilityValue(property: SeedableProperty, source: string): void {
    const types = Array.isArray(property.types) ? property.types : [];
    if (!source) {
        // Nothing declared — `userRoles: ()` reaches here as blank. The field stays empty in
        // whichever mode its template opened in, rather than becoming an empty expression.
        property.value = "";
        return;
    }
    const textMode = types.find((type) => TEXT_MODES.includes(type.fieldType ?? ""));
    const expressionMode = types.find((type) => type.fieldType === EXPRESSION);

    if (textMode && stringLiteral(source)) {
        property.value = literalText(source);
        select(types, textMode);
        return;
    }
    // Anything else is source. A field with no expression editor to switch to keeps the mode it
    // has — a type reference, an enum member or an identifier is already what that field holds.
    property.value = source;
    if (expressionMode) {
        select(types, expressionMode);
    }
}

function select(types: FieldType[], chosen: FieldType): void {
    types.forEach((type) => {
        type.selected = type === chosen;
    });
}
