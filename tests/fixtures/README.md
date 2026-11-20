# Fixtures

Each file here is a list of `{ input, output }` cases. The companion's tests
(`server/`, `cargo test`) read them and must give the same answers. There are two
kinds, and they are kept differently.

## Live: made from the code the browser shares

These are written by the generators in this folder, which run `src/shared` (and
JavaScript's own number and JSON rules) over many inputs. They are what keeps the
companion's twin of that code (`server/src/model`, `i18n.rs`, `sign.rs`,
`touch_trace.rs`) answering as the pages do.

```sh
npm run fixtures
```

writes all of them again; `git diff --exit-code tests/fixtures` afterwards must show
nothing, and CI checks that. So after a change to `src/shared`, to a locale file in
`public/locales` or to a trace in `tests/touchpad-traces`, run it and commit what
changed, together with the matching change in `server/`.

| Generator | Writes |
|---|---|
| `make-model.ts` | everything in `model/` |
| `make-base.ts` | in `base/`: `fill.json`, `iso-dates.json`, `js-number-to-string.json`, `js-string-to-number.json`, `js-value-to-number.json`, `match-language.json`, `parse-accept-language.json`, `placeholders-of.json`, `plural-category.json`, `resolve-language.json`, `stringify.json`, `translator-made-up.json`, `translator-real.json` |
| `make-input.ts` | in `input/`: `trace-events.json`, `trace-frames.json`, `trace-limits.json`, `trace-summaries.json` |
| `make-auth.ts` | in `auth/`: `sign-hash.json`, `sign-request.json` |

## Frozen: what the Node companion answered

Until the companion was rewritten in Rust it was TypeScript run by Node
(`src/server`). The rest of the files are records of what that companion answered,
taken when it was ported, so the Rust one could be held to the same behaviour: same
replies, same files on disk, same bytes. Its code is gone from the tree, and with
it the generators that wrote these files: **they cannot be regenerated, and are not
meant to be.** The last commit that has `src/server` and those generators
(`make-apps.ts`, `make-obs.ts`, `make-server.ts`, `make-sound.ts`, `make-volume.ts`,
and the server halves of `make-base.ts`, `make-input.ts` and `make-auth.ts`) is

    74ed04fe609de2324a0b9fb7d6dfca5012268abb

| Folder | Frozen files |
|---|---|
| `apps/` | all |
| `obs/` | all |
| `server/` | all |
| `sound/` | all |
| `volume/` | all |
| `base/` | `config.json`, `etag.json`, `is-language-setting.json`, `language-for.json`, `languages.json`, `latest-wins.json`, `render.json`, `written-files.json` |
| `input/` | `keys-mac.json`, `keys-tables.json`, `keys-windows.json`, `pointer-lines.json` |
| `auth/` | `auth-claim.json`, `auth-claimant.json`, `auth-devices.json`, `auth-name.json`, `auth-verify.json`, `google-catalog.json`, `google-glyph.json`, `library.json` |

When the companion's behaviour is changed on purpose, the test that reads a frozen
file changes with it: edit the cases by hand, or replace the file with cases written
for the new behaviour. A frozen file is a record, not a rule.

Some of them hold the English of locale messages as it was (`base/render.json`,
`volume/mac-answer.json`): a message that is reworded later needs its cases there
updated by hand.
