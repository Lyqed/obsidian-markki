import { SimpleAnkiSyncSettings } from './settings';
import { GeneratedCard } from './types';

const SYSTEM_PROMPT = `You are an expert at creating Anki flashcards from notes.
Your task is to convert a bullet point into the most suitable Anki flashcard.

Rules:
1. Fix ALL typos and grammatical errors in the bullet text.
2. Choose the best card type:
   - "basic": for concepts, definitions, Q&A. Create a clear question as front and answer as back.
   - "cloze": for fill-in-the-blank, when a key term or fact should be recalled inline. Wrap the key part with {{c1::...}}.
3. For basic cards: front should be a clear question, back should be a concise answer.
4. For cloze cards: return only the "front" field with {{c1::...}} notation (no "back" needed).
5. Choose the most appropriate deck from the provided list based on the content.
6. If no deck fits well (based on the specified specificity level), suggest a new deck name.

IMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation.
Schema:
{
  "cardType": "basic" | "cloze",
  "front": "question or cloze text",
  "back": "answer (only for basic cards, omit for cloze)",
  "deck": "chosen or new deck name",
  "correctedBulletText": "original text with typos fixed (omit if no changes needed)"
}`;

export class LlmService {
  async generateCard(
    bulletText: string,
    availableDecks: string[],
    settings: SimpleAnkiSyncSettings
  ): Promise<GeneratedCard | null> {
    const specificityDesc = [
      'very broad: reuse any existing deck even if loosely related',
      'broad: reuse existing decks when reasonably related',
      'balanced: reuse decks when clearly related, create new if unsure',
      'specific: create a new deck unless an existing one is a strong match',
      'very specific: always create a new narrowly-named deck',
    ][settings.deckSpecificity - 1];

    const userMessage = `Convert this bullet point into an Anki flashcard:
"${bulletText}"

Available decks: ${availableDecks.length > 0 ? availableDecks.join(', ') : '(none yet)'}
Deck specificity: ${settings.deckSpecificity}/5 (${specificityDesc})
Default deck: "${settings.defaultDeck}"`;

    try {
      const raw = settings.llmProvider === 'anthropic'
        ? await this.callAnthropic(userMessage, settings)
        : await this.callOpenAI(userMessage, settings);
      return this.parseResponse(raw);
    } catch (err) {
      console.error('Simple Anki Sync: LLM error:', err);
      return null;
    }
  }

  private async callOpenAI(userMessage: string, settings: SimpleAnkiSyncSettings): Promise<string> {
    const baseUrl = settings.llmApiBaseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.llmApiKey}`,
      },
      body: JSON.stringify({
        model: settings.llmModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI API ${response.status}: ${body}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  private async callAnthropic(userMessage: string, settings: SimpleAnkiSyncSettings): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.llmApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: settings.llmModel,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${body}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text ?? '';
  }

  private parseResponse(content: string): GeneratedCard {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in LLM response');

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.cardType || !parsed.front || !parsed.deck) {
      throw new Error(`LLM response missing required fields: ${content}`);
    }

    return {
      cardType: parsed.cardType === 'cloze' ? 'cloze' : 'basic',
      front: String(parsed.front),
      back: parsed.back ? String(parsed.back) : undefined,
      deck: String(parsed.deck),
      correctedBulletText: parsed.correctedBulletText ? String(parsed.correctedBulletText) : undefined,
    };
  }
}
