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

const TEXT = "TEXT";

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

/** The text a string literal denotes, with the escapes it carries resolved. */
function literalText(source: string): string {
    return source
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}

/**
 * Seeds one property from the source the language server hydrated, choosing the field's mode with
 * it: a string literal fills the text box, anything else is an expression.
 *
 * @param property the form property to seed, edited in place
 * @param source   the value as it stands in the declaration
 */
export function seedCapabilityValue(property: SeedableProperty, source: string): void {
    const types = property.types;
    const hasTextMode = Array.isArray(types) && types.some((type) => type.fieldType === TEXT);
    if (!hasTextMode) {
        // One mode, so the value travels as the form already holds it.
        property.value = source;
        return;
    }
    const asText = stringLiteral(source);
    property.value = asText ? literalText(source) : source;
    types!.forEach((type) => {
        type.selected = asText ? type.fieldType === TEXT : type.fieldType !== TEXT;
    });
}
