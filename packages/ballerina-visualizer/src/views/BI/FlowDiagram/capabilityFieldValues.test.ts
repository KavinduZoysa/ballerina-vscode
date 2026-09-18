// A capability form is a fresh template seeded with source. These pin the half that was missing:
// putting each value in the right mode, so a reference is not written back as a literal.

import { seedCapabilityValue, SeedableProperty } from "./capabilityFieldValues";

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

    it("seeds a field with no declared types at all", () => {
        const property: SeedableProperty = { value: "" };
        seedCapabilityValue(property, "SINGLE_EVENT");
        expect(property.value).toBe("SINGLE_EVENT");
    });
});
