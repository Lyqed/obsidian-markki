# Markki — Claude Instructions

## Project overview
Obsidian plugin that converts bullet points into Anki flashcards via an LLM. Markers are inline HTML comments (`<!-- anki -->`). Cards are synced automatically when content changes.

## Build
```bash
nvm use v20.12.2   # system default is Node v10 — too old for rollup
npm run build      # outputs main.js via rollup
```

## Release process
Always increment the version — never delete and recreate a release.
```bash
# 1. Bump version in both files
sed -i 's/"version": "X.Y.Z"/"version": "X.Y.W"/' manifest.json package.json
npm run build
# 2. Commit, tag, push
git add manifest.json package.json src/...
git commit -m "..."
git tag "X.Y.W"
git push origin main && git push origin "X.Y.W"
# 3. Release — assets must always be named main.js (never versioned filenames)
gh release create "X.Y.W" --title "vX.Y.W" --notes "..." main.js manifest.json
```

## Architecture

### Key files
| File | Role |
|------|------|
| `src/main.ts` | Plugin entry, sync logic, marker parsing, `processFile()` |
| `src/cm6-marker.ts` | CM6 ViewPlugin — hides markers as a purple dot unless cursor is on that line |
| `src/llm-service.ts` | OpenAI-compatible + Anthropic LLM calls via Node.js `https` (bypasses CORS) |
| `src/anki-service.ts` | AnkiConnect wrapper |
| `src/settings.ts` | Settings interface + settings tab |
| `src/types.ts` | `AnkiMarker`, `GeneratedCard`, `ProcessedMediaResult` |

### Marker format
```
- bullet text <!-- anki -->
- bullet text <!-- anki deck="DeckName" -->
- bullet text <!-- anki deck="auto" -->
- bullet text <!-- anki deck="DeckName" id="1234567890" -->
```
`id` is written back after card creation. `deck="auto"` means LLM picks the deck.

### Sync trigger
- CM6 `updateListener` fires on every `docChanged`.
  - If a tracked card ID is no longer in the document text → `processFile()` immediately (deletion).
  - Otherwise → debounce timer (configurable in settings, default 5 s).
- `vault.on('modify')` handles external changes (Obsidian Sync, etc.) with a 2 s debounce.
- `processFile()` is wrapped with a per-file lock (`processingFiles: Set<string>`) to prevent concurrent runs creating duplicate cards.

### Writing card ID back to the file — CRITICAL
**Never use `vault.modify()` or `adapter.write()` for the active file.**

Both cause Obsidian to call `editor.setValue()` internally, which resets the CM6 viewport and makes the screen jump. The correct approach:

1. Call `editor.setLine(lineNum, newLine)` for each changed line only.
2. Store the expected new content in `pendingFileContent: Map<string, string>`.
3. Set `lastWrittenContent` to suppress the upcoming auto-save `vault.on('modify')` event.
4. `_processFile()` checks `pendingFileContent` first before calling `vault.read()`.

For inactive files (no open editor), `vault.modify()` is fine.

### LLM calls
`llm-service.ts` uses Node.js `require('https')` directly — not `fetch()` or Obsidian's `requestUrl()`. This is intentional: Obsidian's renderer blocks CORS preflights for Anthropic's API. The Node.js `https` module runs in the Electron main process context and bypasses CORS entirely.

### Anki card models
- **Basic**: fields `Front`, `Back`
- **Cloze**: fields `Text`, `Back Extra`
- All cards tagged `obsidian_simple_anki_sync_created`

### Backlinks
Format: `obsidian://advanced-uri?vault=X&filepath=Y&line=N`
Requires the [Advanced URI](https://obsidian.md/plugins?id=obsidian-advanced-uri) community plugin. The line number is 1-indexed (`marker.line + 1`).

### Persistent state
Stored via `loadData()`/`saveData()` across plugin restarts:
- `trackedIds: Record<string, number[]>` — file path → list of Anki note IDs
- `bulletTextHashes: Record<string, string>` — note ID → last-synced bullet text

If `bulletTextHashes` has no entry for an existing ID (e.g. after data reset or bullet reorder), initialize it from the current text and skip the LLM call — do not treat it as a new card.

## Settings
| Key | Default | Description |
|-----|---------|-------------|
| `defaultDeck` | `"Default"` | Deck when no deck attr in marker |
| `llmProvider` | `"openai"` | `"openai"` or `"anthropic"` |
| `llmApiBaseUrl` | `"https://api.openai.com/v1"` | Base URL for OpenAI-compatible APIs |
| `llmApiKey` | `""` | API key |
| `llmModel` | `"gpt-4o"` | Model name |
| `autoDeckEnabled` | `false` | Let LLM pick/create the deck |
| `deckSpecificity` | `3` | 1 (broad) to 5 (very specific) |
| `syncDelaySeconds` | `5` | Debounce before syncing an edit |
