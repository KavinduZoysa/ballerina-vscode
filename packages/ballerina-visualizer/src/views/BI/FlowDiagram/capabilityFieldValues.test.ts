// A capability form is a fresh template seeded with source. These pin the half that was missing:
// putting each value in the right mode, so a reference is not written back as a literal.

import { capabilityValueText, seedCapabilityValue, SeedableProperty } from "./capabilityFieldValues";

const dualMode = (): SeedableProperty => ({
    value: "",
    types: [
        { fieldType: "TEXT", selected: true },
        { fieldType: "EXPRESSION", selected: false },
    ],
});

const expressionOnly = (): SeedableProperty => ({ value: "", types: [{ fieldType: "EXPRESSION", selected: true }] });

const modeOf = (property: SeedableProperty) => property.types?.find((type) => type.selected)?.fieldType;

describe("seedCapabilityValue", () => {
    it("puts a string literal in the text box, without its quotes", () => {
        const property = dualMode();
        seedCapabilityValue(property, '"finance"');
        expect(property.value).toBe("finance");
        expect(modeOf(property)).toBe("TEXT");
    });

    it("keeps a bare reference an expression, which is the bug this fixes", () => {
        const property = dualMode();
        seedCapabilityValue(property, "financeRoles");
        expect(property.value).toBe("financeRoles");
        expect(modeOf(property)).toBe("EXPRESSION");
    });

    it.each(['["finance", "ops"]', "string `Order ${id}`", "getRoles()", "config:roles", "()"])(
        "treats %s as an expression",
        (source) => {
            const property = dualMode();
            seedCapabilityValue(property, source);
            expect(property.value).toBe(source);
            expect(modeOf(property)).toBe("EXPRESSION");
        }
    );

    it("resolves the escapes a literal carries", () => {
        const property = dualMode();
        seedCapabilityValue(property, '"Say \\"go\\"\\nnow"');
        expect(property.value).toBe('Say "go"\nnow');
        expect(modeOf(property)).toBe("TEXT");
    });

    it("does not mistake a concatenation that merely starts and ends with a quote", () => {
        const property = dualMode();
        seedCapabilityValue(property, '"a" + b + "c"');
        expect(modeOf(property)).toBe("EXPRESSION");
        expect(property.value).toBe('"a" + b + "c"');
    });

    it("leaves a single-mode field as source, whatever the value looks like", () => {
        const property = expressionOnly();
        seedCapabilityValue(property, '"finance"');
        expect(property.value).toBe('"finance"');
        expect(modeOf(property)).toBe("EXPRESSION");
    });

    it("decodes a literal into a doc box, which is text in a single mode", () => {
        const property: SeedableProperty = { value: "", types: [{ fieldType: "DOC_TEXT", selected: true }] };
        seedCapabilityValue(property, '"Charges the card"');
        expect(property.value).toBe("Charges the card");
        expect(modeOf(property)).toBe("DOC_TEXT");
    });

    it("leaves a text-only field selected when its value is not a literal", () => {
        // A name written as a template has no expression editor to switch to, so the field keeps
        // the only mode it has rather than ending up with none selected.
        const property: SeedableProperty = { value: "", types: [{ fieldType: "TEXT", selected: true }] };
        seedCapabilityValue(property, "string `approve-${id}`");
        expect(property.value).toBe("string `approve-${id}`");
        expect(modeOf(property)).toBe("TEXT");
    });

    it("keeps a type reference and an enum member as they stand", () => {
        const type: SeedableProperty = { value: "", types: [{ fieldType: "TYPE", selected: true }] };
        seedCapabilityValue(type, "ClaimReview");
        expect(type.value).toBe("ClaimReview");
        expect(modeOf(type)).toBe("TYPE");

        const select: SeedableProperty = { value: "", types: [{ fieldType: "SINGLE_SELECT", selected: true }] };
        seedCapabilityValue(select, "SINGLE_EVENT");
        expect(select.value).toBe("SINGLE_EVENT");
        expect(modeOf(select)).toBe("SINGLE_SELECT");
    });

    it("seeds a field with no declared types at all", () => {
        const property: SeedableProperty = { value: "" };
        seedCapabilityValue(property, "SINGLE_EVENT");
        expect(property.value).toBe("SINGLE_EVENT");
    });

    it("reads a value as text for display, decoding only a literal", () => {
        expect(capabilityValueText('"Charges the card"')).toBe("Charges the card");
        expect(capabilityValueText("descriptionVar")).toBe("descriptionVar");
        expect(capabilityValueText(undefined)).toBeUndefined();
        expect(capabilityValueText("")).toBe("");
    });
});
