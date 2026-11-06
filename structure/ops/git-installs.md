# Git Installation Preparation

### Git installation preparation

This fork uses the `prepare` lifecycle hook in `package.json` to run the existing GUI build and
package preparation before a trusted Git installation completes. No release or TypeScript
transpilation is needed, and registry consumers retain the prebuilt package path. Source-archive
compatibility hashing is a prerequisite when the installed source has no `.git` directory.
See the installation guide for explicit script trust.
