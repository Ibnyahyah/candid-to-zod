import { IDL } from "@dfinity/candid";

export interface GenerateConfig {
    /** Optional prefix for generated schema variables, e.g., 'zod' -> 'const zodUser = ...' */
    prefix?: string;
    /** Whether to output TS type inferences alongside schemas */
    inferTypes?: boolean;
}

export function generateZod(idlFactory: ({ IDL }: { IDL: any }) => IDL.ServiceClass, config?: GenerateConfig): string {
    const service = idlFactory({ IDL });
    const typeMap = new Map<string, string>(); // To handle custom Record/Variants mapped to variable names internally

    let output = `import { z } from "zod";\nimport { Principal } from "@dfinity/principal";\n\n`;

    // Provide a generic zod parser for Principals since Zod doesn't support them natively out of the box
    output += `// Principal Zod Schema (Validates string representation or object)\n`;
    output += `export const zPrincipal = z.custom<Principal>(\n  (val) => {\n    try {\n      if (typeof val === "string") {\n        Principal.fromText(val);\n        return true;\n      }\n      if (val && typeof val === "object" && "_isPrincipal" in val) {\n        return true;\n      }\n      return false;\n    } catch (e) {\n      return false;\n    }\n  },\n  { message: "Invalid Canister Principal" }\n);\n\n`;

    // First pass: extract any named types (Records / Variants) that were defined globally
    // _fields contains [methodName, funcClass]
    const serviceFields = service._fields;

    if (!serviceFields || serviceFields.length === 0) {
        return output + `// No service methods found in idlFactory.\n`;
    }

    // A set of seen representations to avoid duplicated inline schemas
    const seenSchemas = new Set<string>();

    // Helper func
    const parseType = (t: any): string => {
        // Primitive types
        if (t instanceof IDL.TextClass) return `z.string()`;
        if (t instanceof IDL.NatClass || t instanceof IDL.IntClass) return `z.bigint()`;

        // Number types (Fixed size)
        if (
            t instanceof IDL.FixedNatClass ||
            t instanceof IDL.FixedIntClass ||
            t instanceof IDL.FloatClass
        ) {
            // JS numbers only safely support up to 2^53-1, so typical 8-32 bit are numbers.
            // In Candid, anything > 32 should technically be a bigint but for simplicity we rely on native runtime mapping if it matches BigInt.
            // By default @dfinity/candid maps everything from Int8 to Int32 to Number, and Int64+ to BigInt.
            if (t.name.includes("64")) return `z.bigint()`;
            return `z.number()`;
        }

        if (t instanceof IDL.BoolClass) return `z.boolean()`;
        if (t instanceof IDL.NullClass) return `z.null()`;
        if (t instanceof IDL.PrincipalClass) return `zPrincipal`;

        // Complex Types
        if (t instanceof IDL.OptClass) {
            return `${parseType(t._type)}.optional().nullable()`;
        }

        if (t instanceof IDL.VecClass) {
            // Candid Vectors can be of any type
            if (t._type instanceof IDL.NatClass && t._type.name === 'nat8' || t._type instanceof IDL.IntClass && t._type.name === 'int8') {
                // For Uint8Array buffers
                return `z.union([z.instanceof(Uint8Array), z.array(z.number())])`;
            }
            return `z.array(${parseType(t._type)})`;
        }

        if (t instanceof IDL.RecordClass) {
            const fields = t._fields.map(([name, ft]: [string, any]) => {
                return `  ${name}: ${parseType(ft)},`;
            }).join("\n");
            return `z.object({\n${fields}\n})`;
        }

        if (t instanceof IDL.VariantClass) {
            // Variants in Candid map to disjoint unions in JS, represented typically as objects with exactly one key.
            const variantTypes = t._fields.map(([name, ft]: [string, any]) => {
                if (ft instanceof IDL.NullClass) {
                    return `z.object({ ${name}: z.null() })`;
                }
                return `z.object({ ${name}: ${parseType(ft)} })`;
            });

            if (variantTypes.length === 1) return variantTypes[0];
            return `z.union([\n  ${variantTypes.join(",\n  ")}\n])`;
        }

        return `z.any()`;
    };

    // Second pass: iterate over all actor functions and export their Argument / Return shapes
    output += `// --- Actor Service Schemas ---\n\n`;
    for (const [methodName, funcClass] of serviceFields) {
        if (!(funcClass instanceof IDL.FuncClass)) continue;

        // Extract Arg Types
        const argTypes = funcClass.argTypes.map(parseType);
        if (argTypes.length > 0) {
            const argSchema = argTypes.length === 1 ? argTypes[0] : `z.tuple([${argTypes.join(", ")}])`;
            output += `export const ${methodName}ArgsSchema = ${argSchema};\n`;
            if (config?.inferTypes) {
                output += `export type ${methodName}Args = z.infer<typeof ${methodName}ArgsSchema>;\n`;
            }
        } else {
            output += `export const ${methodName}ArgsSchema = z.tuple([]);\n`;
        }

        // Extract Ret Types
        const retTypes = funcClass.retTypes.map(parseType);
        if (retTypes.length > 0) {
            const retSchema = retTypes.length === 1 ? retTypes[0] : `z.tuple([${retTypes.join(", ")}])`;
            output += `export const ${methodName}RetSchema = ${retSchema};\n`;
            if (config?.inferTypes) {
                output += `export type ${methodName}Ret = z.infer<typeof ${methodName}RetSchema>;\n`;
            }
        } else {
            output += `export const ${methodName}RetSchema = z.void();\n`;
        }

        output += `\n`;
    }

    return output;
}
