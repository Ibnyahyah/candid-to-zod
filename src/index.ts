// @ts-ignore
import { idlFactory } from "../test.did.js";
import { generateZod } from "./generator.js";

const result = generateZod(idlFactory, { inferTypes: true });
console.log(result);
