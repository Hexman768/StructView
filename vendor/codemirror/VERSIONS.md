# Vendored CodeMirror modules

These exact ESM package versions are vendored for offline desktop use. The
module files were downloaded from `https://esm.sh/` with dependencies left as
bare imports and resolved locally by the import map in `index.html`.

- codemirror 6.0.2
- @codemirror/autocomplete 6.20.3
- @codemirror/commands 6.11.0
- @codemirror/language 6.12.4
- @codemirror/lint 6.9.7
- @codemirror/search 6.7.2
- @codemirror/state 6.7.2
- @codemirror/view 6.43.10
- @codemirror/lang-json 6.0.2
- @codemirror/lang-yaml 6.1.3
- @lezer/common 1.5.2
- @lezer/highlight 1.2.3
- @lezer/lr 1.4.10
- @lezer/json 1.0.3
- @lezer/yaml 1.0.4
- @marijn/find-cluster-break 1.0.4
- crelt 1.0.7
- style-mod 4.1.3
- w3c-keyname 2.2.8

The packages are MIT-licensed. See `LICENSE.txt`.

`process-shim.mjs` replaces esm.sh's Node process shim with the only property
the Lezer LR runtime reads in a browser (`process.env`).
