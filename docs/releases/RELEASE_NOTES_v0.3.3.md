# Release Notes - v0.3.3

**Release Date:** 2025-12-09
**Previous Version:** 0.3.2
**Release Type:** Patch (Critical bug fix)

---

## Summary

**Critical fix for broken v0.3.2 npm package.** The v0.3.2 release was published without the `dist/` directory, making the package non-functional.

### What Happened

The v0.3.2 npm publish failed because:
1. The `clean` script removed `.tsbuildinfo`
2. But TypeScript actually creates `tsconfig.tsbuildinfo`
3. Stale build cache caused TypeScript to skip compilation
4. The `dist/` directory was removed but not rebuilt
5. npm published an empty package

### What's Fixed

- Clean script now removes the correct file (`tsconfig.tsbuildinfo`)
- Fresh build verified before publish

---

## Bug Fixes

### Fixed broken npm package

v0.3.2 contained only 3 files (LICENSE, README.md, package.json) instead of the full compiled package. Users who installed v0.3.2 would get a non-functional package.

**If you installed v0.3.2**, please upgrade immediately:
```bash
npm install autobeat@0.3.3
```

### Fixed clean script

Changed build cleanup from `.tsbuildinfo` to `tsconfig.tsbuildinfo` to match the actual filename TypeScript generates.

---

## Migration Guide

If you have v0.3.2 installed:
```bash
npm update autobeat
# or
npm install autobeat@latest
```

---

## Verification

After installation, verify the package is complete:
```bash
ls node_modules/autobeat/dist/
# Should show: cli.js, index.js, and subdirectories
```
