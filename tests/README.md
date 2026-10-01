# Import integration tests

Run `npm ci`, then `npm test`. Tests use the installed Microsoft Edge on Windows.
On other platforms, install the test browser with `npx playwright install chromium`.
Set `PLAYWRIGHT_CHANNEL` to select another installed browser channel.

The tests serve the local editor, exercise its import dialog and file input, and
verify rendered content and local persistence. Firebase is replaced by an in-memory
stub, and all external HTTP requests are blocked. No account or cloud data is used.

The SBX fixtures are reconstructed from StudioBinder's official
[application bundle](https://apps3.studiobinder.com/dist/production/2.21.1021/js/studiobinder-app-combined.js?v=1786909189),
specifically `ScriptConvertService` and `DocumentVersionEditorCtrl`'s `DOWNLOAD_SBX`
handler. They model its HTML export with `divtype0` through `divtype11` screenplay
element classes; they are not a user-provided export.

The editor stores plain text and paragraph types, so inline styling, original scene
numbers and explicit page breaks are not retained. Scene numbers are regenerated,
dual dialogue is flattened in file order, and the filename becomes the script title.
