const esbuild = require("esbuild");

esbuild.build({
    entryPoints: ["main.ts"],
    bundle: true,
    outfile: "main.js",
    format: "cjs",
    target: "es2018",
    external: ["obsidian"]
}).catch(() => process.exit(1));