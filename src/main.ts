import { Plugin, TFile, MarkdownView, Notice, arrayBufferToBase64 } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { AnkiService } from './anki-service';
import { LlmService } from './llm-service';
import { AnkiMarker, GeneratedCard, ProcessedMediaResult } from './types';
import { DEFAULT_SETTINGS, SimpleAnkiSyncSettingTab, SimpleAnkiSyncSettings } from './settings';
import { createAnkiMarkerExtension } from './cm6-marker';

interface PluginData {
  settings: SimpleAnkiSyncSettings;
  trackedIds: Record<string, number[]>;
  bulletTextHashes: Record<string, string>;
}

// ── Regex ──────────────────────────────────────────────────────────────────
const ANKI_MARKER_RE = /<!--\s*anki(?:\s[^>]*)?\s*-->/;
const IMAGE_EMBED = /!\[\[([^|\]\n]+)(?:\|(\d+))?\]\]/g;
const BLOCK_LATEX = /\$\$([\s\S]*?)\$\$/g;
const INLINE_LATEX = /(?<![\$\\])\$([^$]+?)(?<!\\)\$/g;

// ── Marker helpers ─────────────────────────────────────────────────────────

function parseMarkerAttrs(markerText: string): { id?: number; deck?: string } {
  const idMatch = markerText.match(/\bid="(\d+)"/);
  const deckMatch = markerText.match(/\bdeck="([^"]+)"/);
  return {
    id: idMatch ? parseInt(idMatch[1], 10) : undefined,
    deck: deckMatch ? deckMatch[1] : undefined,
  };
}

function parseAnkiMarkers(content: string): AnkiMarker[] {
  const lines = content.split('\n');
  const markers: AnkiMarker[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(ANKI_MARKER_RE);
    if (!match) continue;

    const markerText = match[0];
    const attrs = parseMarkerAttrs(markerText);

    // Bullet text = everything before the marker, stripped of leading bullet chars
    const textPart = line.slice(0, match.index).trim();
    const bulletText = textPart.replace(/^[\s]*(?:[-*+]|\d+\.)\s+/, '');

    markers.push({
      line: i,
      id: attrs.id,
      deck: attrs.deck,
      bulletText,
      markerFull: markerText,
    });
  }

  return markers;
}

function buildMarker(attrs: { id?: number; deck?: string }): string {
  const parts: string[] = ['anki'];
  if (attrs.deck) parts.push(`deck="${attrs.deck}"`);
  if (attrs.id !== undefined) parts.push(`id="${attrs.id}"`);
  return `<!-- ${parts.join(' ')} -->`;
}

/** Replace the anki marker on a line while preserving all other attrs. */
function replaceMarkerOnLine(line: string, newAttrs: { id?: number; deck?: string }): string {
  return line.replace(ANKI_MARKER_RE, buildMarker(newAttrs));
}

/** Replace the bullet text portion of a line, keeping indent, bullet char, and marker intact. */
function replaceBulletText(line: string, newText: string): string {
  const match = line.match(/^([\s]*(?:[-*+]|\d+\.)\s+)(.*?)\s*(<!--\s*anki(?:\s[^>]*)?\s*-->)(.*)?$/s);
  if (!match) return line;
  return `${match[1]}${newText} ${match[3]}${match[4] ?? ''}`;
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export default class SimpleAnkiSyncPlugin extends Plugin {
  private anki!: AnkiService;
  private llm!: LlmService;
  public settings: SimpleAnkiSyncSettings = DEFAULT_SETTINGS;

  // Debounce timers for external file changes only
  private externalSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Cross-session state persisted via loadData/saveData
  private trackedIds = new Map<string, Set<number>>();
  private bulletTextHashes = new Map<number, string>();
  // Guard: content we wrote ourselves (to skip re-triggering on vault.modify)
  private lastWrittenContent = new Map<string, string>();

  async onload() {
    console.log('Loading Simple Anki Sync Plugin');
    this.anki = new AnkiService(this.app);
    this.llm = new LlmService();

    await this.loadPersistedData();

    this.addSettingTab(new SimpleAnkiSyncSettingTab(this.app, this));

    // ── CM6 extension: marker hiding + cursor-leaves-line trigger ─────────
    this.registerEditorExtension(
      createAnkiMarkerExtension((_view: EditorView) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.processFile(file).catch((err) => {
            console.error(`Markki: error processing ${file.path}:`, err);
          });
        }
      })
    );

    // ── Fallback: handle external file changes (Obsidian Sync, etc.) ──────
    this.registerEvent(
      this.app.vault.on('modify', async (abstractFile) => {
        if (!(abstractFile instanceof TFile)) return;
        if (abstractFile.extension !== 'md') return;
        // Skip if this modify was triggered by our own write
        if (this.lastWrittenContent.get(abstractFile.path) !== undefined) {
          const content = await this.app.vault.read(abstractFile);
          if (this.lastWrittenContent.get(abstractFile.path) === content) {
            this.lastWrittenContent.delete(abstractFile.path);
            return;
          }
          this.lastWrittenContent.delete(abstractFile.path);
        }
        // Short debounce for external changes (Obsidian Sync, etc.)
        const existing = this.externalSyncTimers.get(abstractFile.path);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(async () => {
          this.externalSyncTimers.delete(abstractFile.path);
          try {
            await this.processFile(abstractFile);
          } catch (err) {
            console.error(`Markki: error processing ${abstractFile.path}:`, err);
          }
        }, 2000);
        this.externalSyncTimers.set(abstractFile.path, timer);
      })
    );

    // ── Commands ──────────────────────────────────────────────────────────
    this.addCommand({
      id: 'mark-bullet-as-anki-card',
      name: 'Mark bullet as Anki card',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.editor) return false;
        if (checking) return true;

        const editor = view.editor;
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);

        // Only mark if it looks like a bullet and doesn't already have a marker
        if (ANKI_MARKER_RE.test(line)) {
          new Notice('This line already has an Anki marker.');
          return;
        }

        const trimmed = line.trim();
        if (!trimmed.startsWith('-') && !trimmed.startsWith('*') && !trimmed.startsWith('+') && !/^\d+\./.test(trimmed)) {
          new Notice('Place the cursor on a bullet point line.');
          return;
        }

        const newLine = line.trimEnd() + ' <!-- anki -->';
        editor.setLine(cursor.line, newLine);
      },
    });

  }

  onunload() {
    console.log('Unloading Simple Anki Sync Plugin');
    // Cancel pending timers
    for (const timer of this.externalSyncTimers.values()) clearTimeout(timer);
    this.externalSyncTimers.clear();
    // Persist state
    this.persistData();
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  private async loadPersistedData(): Promise<void> {
    const data = (await this.loadData()) as PluginData | null;
    if (!data) {
      this.settings = { ...DEFAULT_SETTINGS };
      return;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});

    if (data.trackedIds) {
      for (const [path, ids] of Object.entries(data.trackedIds)) {
        this.trackedIds.set(path, new Set(ids));
      }
    }
    if (data.bulletTextHashes) {
      for (const [id, text] of Object.entries(data.bulletTextHashes)) {
        this.bulletTextHashes.set(parseInt(id, 10), text);
      }
    }
  }

  public async saveSettings(): Promise<void> {
    await this.persistData();
  }

  private async persistData(): Promise<void> {
    const trackedIdsObj: Record<string, number[]> = {};
    for (const [path, ids] of this.trackedIds.entries()) {
      trackedIdsObj[path] = [...ids];
    }
    const bulletHashesObj: Record<string, string> = {};
    for (const [id, text] of this.bulletTextHashes.entries()) {
      bulletHashesObj[id.toString()] = text;
    }
    const data: PluginData = {
      settings: this.settings,
      trackedIds: trackedIdsObj,
      bulletTextHashes: bulletHashesObj,
    };
    await this.saveData(data);
  }

  // ── Core sync logic ───────────────────────────────────────────────────────

  private async processFile(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const markers = parseAnkiMarkers(content);

    // Skip files with no anki markers
    if (markers.length === 0) {
      // Still clean up tracked IDs if we know some used to exist
      const previousIds = this.trackedIds.get(file.path);
      if (previousIds && previousIds.size > 0) {
        if (await this.anki.isConnected()) {
          await this.anki.deleteNotes([...previousIds]);
          this.trackedIds.delete(file.path);
          await this.persistData();
        }
      }
      return;
    }

    // Silently bail if Anki isn't reachable
    if (!(await this.anki.isConnected())) return;

    const currentIds = new Set(
      markers.filter((m) => m.id !== undefined).map((m) => m.id!)
    );
    const previousIds = this.trackedIds.get(file.path) ?? new Set<number>();

    // Delete cards whose markers were removed
    const removedIds = [...previousIds].filter((id) => !currentIds.has(id));
    if (removedIds.length > 0) {
      await this.anki.deleteNotes(removedIds);
      for (const id of removedIds) this.bulletTextHashes.delete(id);
    }

    // Fetch decks once for LLM (only when auto-deck enabled)
    const availableDecks = this.settings.autoDeckEnabled ? await this.anki.fetchDecks() : [];

    const vault = this.app.vault.getName();
    const lines = content.split('\n');
    let contentChanged = false;

    for (const marker of markers) {
      if (marker.id === undefined) {
        // ── New marker: generate card and create in Anki ──
        const generated = await this.llm.generateCard(marker.bulletText, availableDecks, this.settings);
        if (!generated) {
          new Notice(`Simple Anki Sync: failed to generate card for "${marker.bulletText.slice(0, 40)}"`);
          continue;
        }

        const deck = this.resolveDeck(marker.deck, generated.deck);
        await this.anki.createDeck(deck);

        const { front, back } = await this.prepareCardContent(generated, file);
        const model = generated.cardType === 'cloze' ? 'Cloze' : 'Basic';
        const fields: Record<string, string> = generated.cardType === 'cloze'
          ? { Text: front, 'Back Extra': '' }
          : { Front: front, Back: back };

        const noteId = await this.anki.addNote(deck, model, fields);
        if (!noteId) continue;

        // Now update the card with the real backlink URL (now that we have the ID)
        const finalBack = this.appendObsidianLink(back, vault, file.path, noteId, marker.line + 1);
        const finalFields: Record<string, string> = generated.cardType === 'cloze'
          ? { Text: front, 'Back Extra': finalBack }
          : { Front: front, Back: finalBack };
        await this.anki.updateNote(noteId, finalFields);

        // Update the line: write the ID (and resolved deck if it was "auto")
        const newDeck = marker.deck === 'auto' ? generated.deck : marker.deck;
        lines[marker.line] = replaceMarkerOnLine(lines[marker.line], {
          id: noteId,
          deck: newDeck,
        });

        // Apply corrected text if LLM changed it
        const finalText = generated.correctedBulletText ?? marker.bulletText;
        if (generated.correctedBulletText && generated.correctedBulletText !== marker.bulletText) {
          lines[marker.line] = replaceBulletText(lines[marker.line], generated.correctedBulletText);
        }

        this.bulletTextHashes.set(noteId, finalText);
        currentIds.add(noteId);
        contentChanged = true;

      } else {
        // ── Existing marker: update if text changed ──
        const prevHash = this.bulletTextHashes.get(marker.id);
        if (prevHash !== undefined && prevHash === marker.bulletText) continue;

        const generated = await this.llm.generateCard(marker.bulletText, availableDecks, this.settings);
        if (!generated) continue;

        const { front, back } = await this.prepareCardContent(generated, file);
        const finalBack = this.appendObsidianLink(back, vault, file.path, marker.id, marker.line + 1);
        const finalFields: Record<string, string> = generated.cardType === 'cloze'
          ? { Text: front, 'Back Extra': finalBack }
          : { Front: front, Back: finalBack };
        await this.anki.updateNote(marker.id, finalFields);

        const finalText = generated.correctedBulletText ?? marker.bulletText;
        if (generated.correctedBulletText && generated.correctedBulletText !== marker.bulletText) {
          lines[marker.line] = replaceBulletText(lines[marker.line], generated.correctedBulletText);
          contentChanged = true;
        }

        this.bulletTextHashes.set(marker.id, finalText);
      }
    }

    this.trackedIds.set(file.path, currentIds);

    if (contentChanged) {
      const newContent = lines.join('\n');
      this.lastWrittenContent.set(file.path, newContent);

      // Save scroll position before the file modify resets it
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const isActiveFile = activeView?.file?.path === file.path;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scrollDOM = isActiveFile ? (activeView?.editor as any)?.cm?.scrollDOM as HTMLElement | undefined : undefined;
      const savedScrollTop = scrollDOM?.scrollTop ?? 0;

      await this.app.vault.modify(file, newContent);

      if (scrollDOM && savedScrollTop > 0) {
        window.setTimeout(() => { scrollDOM.scrollTop = savedScrollTop; }, 50);
      }
    }

    await this.persistData();
    await this.anki.syncToAnkiWeb();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private resolveDeck(markerDeck: string | undefined, llmDeck: string): string {
    if (!markerDeck || markerDeck === 'auto') {
      return this.settings.autoDeckEnabled ? llmDeck : this.settings.defaultDeck;
    }
    return markerDeck;
  }

  private appendObsidianLink(back: string, vault: string, filePath: string, _noteId: number, line?: number): string {
    // Use Advanced URI plugin format when a line number is available — opens the exact bullet.
    // Falls back to plain obsidian://open if no line is given.
    const url = line !== undefined
      ? `obsidian://advanced-uri?vault=${encodeURIComponent(vault)}&filepath=${encodeURIComponent(filePath)}&line=${line}`
      : `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(filePath)}`;
    const sep = back ? '<br>' : '';
    return `${back}${sep}<small><a href="${url}" style="text-decoration:none;color:grey;font-size:0.8em;">Open in Obsidian</a></small>`;
  }

  private async prepareCardContent(
    generated: GeneratedCard,
    file: TFile
  ): Promise<{ front: string; back: string }> {
    let front = generated.front ?? '';
    let back = generated.back ?? '';

    const frontMed = await this.processMedia(front, file);
    const backMed = await this.processMedia(back, file);
    for (const u of [...frontMed.mediaToUpload, ...backMed.mediaToUpload]) {
      await this.anki.storeMediaBase64(u.ankiFileName, u.dataBase64);
    }

    front = this.convertLatexDelimiters(frontMed.content);
    back = this.convertLatexDelimiters(backMed.content);
    front = this.convertMarkdownBoldToHtml(front);
    back = this.convertMarkdownBoldToHtml(back);

    return { front, back };
  }

  private async processMedia(text: string, file: TFile): Promise<ProcessedMediaResult> {
    let out = text;
    const uploads: { ankiFileName: string; dataBase64: string }[] = [];

    const matches = Array.from(text.matchAll(IMAGE_EMBED));
    for (const m of matches) {
      const [md, linkPath, size] = m;
      const imageFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
      if (!(imageFile instanceof TFile)) continue;

      let dataBase64 = '';
      let ankiFileName = imageFile.name;
      const randomSuffix = Math.floor(Math.random() * 10_000_000);

      const windowAsAny = window as unknown as Record<string, unknown>;
      const ea = windowAsAny.ExcalidrawAutomate as
        | { isExcalidrawFile(f: TFile): boolean; createPNG(path: string, scale: number): Promise<Blob> }
        | undefined;
      const isExcalidraw = ea?.isExcalidrawFile(imageFile) ?? false;

      if (isExcalidraw && ea) {
        try {
          const blob = await ea.createPNG(imageFile.path, 1.5);
          dataBase64 = arrayBufferToBase64(await blob.arrayBuffer());
          ankiFileName = `${imageFile.basename}_${randomSuffix}.png`;
        } catch (e) {
          console.error('Simple Anki Sync: Excalidraw PNG failed', e);
          dataBase64 = arrayBufferToBase64(await this.app.vault.readBinary(imageFile));
        }
      } else {
        dataBase64 = arrayBufferToBase64(await this.app.vault.readBinary(imageFile));
      }

      uploads.push({ ankiFileName, dataBase64 });
      const encodedFileName = encodeURIComponent(ankiFileName);
      const tag = size ? `<img src="${encodedFileName}" width="${size}">` : `<img src="${encodedFileName}">`;
      out = out.replace(md, tag);
    }

    return { content: out, mediaToUpload: uploads };
  }

  private convertLatexDelimiters(text: string): string {
    return text.replace(BLOCK_LATEX, '\\[$1\\]').replace(INLINE_LATEX, '\\($1\\)');
  }

  private convertMarkdownBoldToHtml(text: string): string {
    return text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  }
}
