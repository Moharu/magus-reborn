// Lint toolchain for the root eslint.config.js.
//
// typescript-eslint parses with the TypeScript JS API (`require('typescript')`), which
// TypeScript 7 no longer ships, and it only supports TypeScript < 6.1. This workspace pins
// typescript@6 so that typescript-eslint resolves it from here, while the rest of the repo
// keeps compiling and typechecking with TypeScript 7. The root `overrides` entry for
// ts-api-utils (a typescript-eslint dependency) narrows its `typescript` peer to 6.0 so npm
// installs it here too; otherwise it is hoisted and loads TypeScript 7 from the root.
export { default as js } from '@eslint/js'
export { default as tseslint } from 'typescript-eslint'
export { default as prettier } from 'eslint-config-prettier/flat'
