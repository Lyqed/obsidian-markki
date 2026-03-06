<div align="center">
  <img src="images/logo.svg" alt="Markki" width="480"/>
</div>

<br>

> **Prerequisite:** Anki must be running with [AnkiConnect](https://ankiweb.net/shared/info/2055492159) installed.

---

Markki is an Obsidian plugin that turns bullet points into Anki flashcards, automatically. Mark a bullet and an AI generates the best card type, fixes your typos, picks the right deck, and syncs to Anki. No manual sync commands. No reformatting.

---

## How it works

1. Place your cursor on any bullet point
2. Run the command **"Mark bullet as Anki card"** (assign it a hotkey)
3. A tiny purple dot `⬤` appears at the end of the line, invisible until you need it
4. After **15 seconds** of inactivity, the AI generates the card and it appears in Anki
5. **Delete the dot** → the Anki card is deleted automatically

The marker is a plain HTML comment `<!-- anki -->`. It's invisible in reading view, hidden as a dot in the editor, and fully editable when your cursor is on the line.

---

## Marker syntax

```
- bullet text <!-- anki -->                    → uses default deck
- bullet text <!-- anki deck="MyDeck" -->      → explicit deck
- bullet text <!-- anki deck="auto" -->        → AI picks the best deck
```

After sync, the card ID is written back silently:
```
- bullet text <!-- anki deck="MyDeck" id="1234567890" -->
```

---

## Card types

The AI chooses the best type automatically:

- **Basic**: question + answer (most content)
- **Cloze**: fill-in-the-blank, for when a specific term should be recalled inline (`{{c1::...}}`)

---

## Settings

| Setting | Description |
|---------|-------------|
| Default deck | Deck used when no deck is specified in the marker |
| Provider | `OpenAI / Compatible` or `Anthropic (Claude)` |
| API base URL | For OpenAI-compatible APIs (Ollama, LM Studio, etc.) |
| API key | Your provider API key |
| Model | e.g. `gpt-4o`, `claude-haiku-4-5-20251001` |
| Auto-detect deck | Let the AI pick or create the best deck |
| Deck specificity | 1 = reuse broadly · 5 = always create a specific new deck |

---

## Installation

**Manual:**
1. Download `main.js` and `manifest.json` from the [latest release](../../releases/latest)
2. Create `.obsidian/plugins/markki/` in your vault
3. Place both files there
4. Enable in **Settings → Community Plugins → Markki**

**From source:**
```bash
git clone https://github.com/Lyqed/obsidian-markki.git
cd obsidian-markki
npm install
npm run build
```
Then copy `main.js` and `manifest.json` to `.obsidian/plugins/markki/`.

---

## Backlinks

Every card includes an **"Open in Obsidian"** link. Clicking it from Anki opens the note and scrolls to the exact bullet. Works on Android.

---

## Notes

- All synced cards are tagged `obsidian_simple_anki_sync_created` in Anki for easy filtering
- Images (`![[image.png]]`), LaTeX (`$...$`, `$$...$$`), bold (`**text**`), and Excalidraw files are all supported
- Card state survives plugin restarts. Tracked IDs are persisted locally
- If Anki is not running, sync is silently skipped and retried on next edit
