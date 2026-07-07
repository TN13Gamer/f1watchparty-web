import { readFileSync, writeFileSync } from "fs";
const admin = readFileSync("admin.html", "utf-8");
writeFileSync("src/embed-html.js", `export const adminHtml = ${JSON.stringify(admin)};\n`);
console.log("HTML embedded into src/embed-html.js");
