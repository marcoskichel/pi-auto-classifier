# Changelog

## [1.3.1](https://github.com/marcoskichel/pi-auto-classifier/compare/pi-auto-classifier-v1.3.0...pi-auto-classifier-v1.3.1) (2026-08-13)


### Bug Fixes

* cap the STE rule at one failure per turn ([#41](https://github.com/marcoskichel/pi-auto-classifier/issues/41)) ([06db214](https://github.com/marcoskichel/pi-auto-classifier/commit/06db2143b4542bebc9da97dff83d4745e50272f6))

## [1.3.0](https://github.com/marcoskichel/pi-auto-classifier/compare/pi-auto-classifier-v1.2.0...pi-auto-classifier-v1.3.0) (2026-08-12)


### Features

* show withheld replies as one expandable chat line ([#37](https://github.com/marcoskichel/pi-auto-classifier/issues/37)) ([9176e4b](https://github.com/marcoskichel/pi-auto-classifier/commit/9176e4b5ff24f31fabca5cbdc56db069d34a4aea))
* toggle individual classifier rules ([#40](https://github.com/marcoskichel/pi-auto-classifier/issues/40)) ([e5807c4](https://github.com/marcoskichel/pi-auto-classifier/commit/e5807c4f8671a335457c3b479ac8358d6afc8147))

## [1.2.0](https://github.com/marcoskichel/pi-auto-classifier/compare/pi-auto-classifier-v1.1.1...pi-auto-classifier-v1.2.0) (2026-08-11)


### Features

* let a rule cap itself at one failure per turn ([#34](https://github.com/marcoskichel/pi-auto-classifier/issues/34)) ([1102fac](https://github.com/marcoskichel/pi-auto-classifier/commit/1102fac16818d8f31999d4557eb836cede2dfdb2))


### Bug Fixes

* match blocked rules by heading in the override check ([#33](https://github.com/marcoskichel/pi-auto-classifier/issues/33)) ([26243ca](https://github.com/marcoskichel/pi-auto-classifier/commit/26243caf952ddd788bbc2835d5a0c0dfd9b129cc))
* run pi with --extension instead of rewriting settings.json ([#35](https://github.com/marcoskichel/pi-auto-classifier/issues/35)) ([1951155](https://github.com/marcoskichel/pi-auto-classifier/commit/1951155bab5ea3d14e94e54024b72a4f46f8f051))

## [1.1.1](https://github.com/marcoskichel/pi-auto-classifier/compare/pi-auto-classifier-v1.1.0...pi-auto-classifier-v1.1.1) (2026-08-07)


### Bug Fixes

* never re-classify the withheld placeholder ([#31](https://github.com/marcoskichel/pi-auto-classifier/issues/31)) ([1f2da43](https://github.com/marcoskichel/pi-auto-classifier/commit/1f2da436c5f1279c8dd91802c3911b2b8ceb031c))

## [1.1.0](https://github.com/marcoskichel/pi-auto-classifier/compare/pi-auto-classifier-v1.0.0...pi-auto-classifier-v1.1.0) (2026-08-07)


### Features

* include violation reasons in withheld placeholder ([#28](https://github.com/marcoskichel/pi-auto-classifier/issues/28)) ([2f56889](https://github.com/marcoskichel/pi-auto-classifier/commit/2f56889cb96df047e5a00c179a3010be8b397a79))

## [1.0.0](https://github.com/marcoskichel/pi-auto-classifier/compare/pi-auto-classifier-v0.4.0...pi-auto-classifier-v1.0.0) (2026-08-06)


### ⚠ BREAKING CHANGES

* the package is now published as pi-auto-classifier. Env vars are PI_AUTO_CLASSIFIER_MODEL and PI_AUTO_CLASSIFIER_DEBUG. The config file is auto-classifier.json in both the project and global locations.

### Features

* add classifier initial implementation ([e1d4181](https://github.com/marcoskichel/pi-auto-classifier/commit/e1d41819d940039d35639e94789287b88b071235))
* add package.json for npm publishing and pi.dev gallery ([#2](https://github.com/marcoskichel/pi-auto-classifier/issues/2)) ([bfd3920](https://github.com/marcoskichel/pi-auto-classifier/commit/bfd3920f3b32634d964169d2368dfd18dc65ac80))
* add release-please workflow with npm OIDC publishing ([#3](https://github.com/marcoskichel/pi-auto-classifier/issues/3)) ([a625ab3](https://github.com/marcoskichel/pi-auto-classifier/commit/a625ab373d23396d4e0f80d200a59f934af424ae))
* add testing-locally skill and dev script ([#18](https://github.com/marcoskichel/pi-auto-classifier/issues/18)) ([cff9c1d](https://github.com/marcoskichel/pi-auto-classifier/commit/cff9c1df7fadfb8e9bcc6ca361c21cbd241327fa))
* block at most once per rule ([#6](https://github.com/marcoskichel/pi-auto-classifier/issues/6)) ([e8028de](https://github.com/marcoskichel/pi-auto-classifier/commit/e8028de059a9c792ec785d9c51e4b36082072e94))
* classify and block tool calls against tool rules ([#17](https://github.com/marcoskichel/pi-auto-classifier/issues/17)) ([0b62dc2](https://github.com/marcoskichel/pi-auto-classifier/commit/0b62dc2b926ea1779c3814f6bc2ec2e100abfa4b))
* let a clear user request override a tool rule ([#21](https://github.com/marcoskichel/pi-auto-classifier/issues/21)) ([ccd5e77](https://github.com/marcoskichel/pi-auto-classifier/commit/ccd5e778091a6f56a08af2e1665841104b47f60b))
* move classifier badge into the status bar ([#15](https://github.com/marcoskichel/pi-auto-classifier/issues/15)) ([6cfc6bb](https://github.com/marcoskichel/pi-auto-classifier/commit/6cfc6bbd3a238dc8d23a39a291c310eaf1ea9701))
* remove toggle shortcut in favor of /classifier command ([#10](https://github.com/marcoskichel/pi-auto-classifier/issues/10)) ([a8813e7](https://github.com/marcoskichel/pi-auto-classifier/commit/a8813e77502b80e4162d014bc2b8231f65219625))
* rename project to pi-auto-classifier ([#22](https://github.com/marcoskichel/pi-auto-classifier/issues/22)) ([b1bd3e2](https://github.com/marcoskichel/pi-auto-classifier/commit/b1bd3e28f373ae6c761f813cbf84caa2431f0e23))
* retry rewrites until the reply passes ([#13](https://github.com/marcoskichel/pi-auto-classifier/issues/13)) ([67e6a28](https://github.com/marcoskichel/pi-auto-classifier/commit/67e6a280cf6c21c69a5034a82f04fd4c9e2d6eba))


### Bug Fixes

* change toggle shortcut to ctrl+alt+b to avoid built-in ctrl+b conflict ([#5](https://github.com/marcoskichel/pi-auto-classifier/issues/5)) ([4076ad8](https://github.com/marcoskichel/pi-auto-classifier/commit/4076ad8c1efe4a8d399c1c534fb74bcea6b8cf78))
* shortcut toggle ([69da7ea](https://github.com/marcoskichel/pi-auto-classifier/commit/69da7ea74a50aeab286d203f2620ef73738b5fe3))

## [0.4.0](https://github.com/marcoskichel/pi-output-classifier/compare/pi-output-classifier-v0.3.0...pi-output-classifier-v0.4.0) (2026-08-06)


### Features

* move classifier badge into the status bar ([#15](https://github.com/marcoskichel/pi-output-classifier/issues/15)) ([6cfc6bb](https://github.com/marcoskichel/pi-output-classifier/commit/6cfc6bbd3a238dc8d23a39a291c310eaf1ea9701))

## [0.3.0](https://github.com/marcoskichel/pi-output-classifier/compare/pi-output-classifier-v0.2.0...pi-output-classifier-v0.3.0) (2026-08-06)


### Features

* remove toggle shortcut in favor of /classifier command ([#10](https://github.com/marcoskichel/pi-output-classifier/issues/10)) ([a8813e7](https://github.com/marcoskichel/pi-output-classifier/commit/a8813e77502b80e4162d014bc2b8231f65219625))
* retry rewrites until the reply passes ([#13](https://github.com/marcoskichel/pi-output-classifier/issues/13)) ([67e6a28](https://github.com/marcoskichel/pi-output-classifier/commit/67e6a280cf6c21c69a5034a82f04fd4c9e2d6eba))

## [0.2.0](https://github.com/marcoskichel/pi-output-classifier/compare/pi-output-classifier-v0.1.0...pi-output-classifier-v0.2.0) (2026-08-05)


### Features

* add classifier initial implementation ([e1d4181](https://github.com/marcoskichel/pi-output-classifier/commit/e1d41819d940039d35639e94789287b88b071235))
* add package.json for npm publishing and pi.dev gallery ([#2](https://github.com/marcoskichel/pi-output-classifier/issues/2)) ([bfd3920](https://github.com/marcoskichel/pi-output-classifier/commit/bfd3920f3b32634d964169d2368dfd18dc65ac80))
* add release-please workflow with npm OIDC publishing ([#3](https://github.com/marcoskichel/pi-output-classifier/issues/3)) ([a625ab3](https://github.com/marcoskichel/pi-output-classifier/commit/a625ab373d23396d4e0f80d200a59f934af424ae))
* block at most once per rule ([#6](https://github.com/marcoskichel/pi-output-classifier/issues/6)) ([e8028de](https://github.com/marcoskichel/pi-output-classifier/commit/e8028de059a9c792ec785d9c51e4b36082072e94))


### Bug Fixes

* change toggle shortcut to ctrl+alt+b to avoid built-in ctrl+b conflict ([#5](https://github.com/marcoskichel/pi-output-classifier/issues/5)) ([4076ad8](https://github.com/marcoskichel/pi-output-classifier/commit/4076ad8c1efe4a8d399c1c534fb74bcea6b8cf78))
* shortcut toggle ([69da7ea](https://github.com/marcoskichel/pi-output-classifier/commit/69da7ea74a50aeab286d203f2620ef73738b5fe3))
