import type { LinkReference } from './types';

export type MarkdownTextSegment =
  | { type: 'text'; text: string }
  | {
      type: 'link';
      key: string;
      displayText: string;
      token: LinkReference;
      external: boolean;
    };

export function parseMarkdownTextSegments(text: string): MarkdownTextSegment[] {
  const segments: MarkdownTextSegment[] = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < text.length) {
    const wikiStart = text.indexOf('[[', cursor);
    const markdownStart = findNextMarkdownLinkStart(text, cursor);
    const imageStart = findNextImageLinkStart(text, cursor);
    const nextStart = firstNonNegative([wikiStart, markdownStart, imageStart]);

    if (nextStart === -1) {
      break;
    }

    const parsed =
      nextStart === wikiStart
        ? parseWikiLink(text, nextStart)
        : nextStart === imageStart
          ? parseMarkdownLink(text, nextStart, true)
          : parseMarkdownLink(text, nextStart, false);

    if (!parsed) {
      cursor = nextStart + 1;
      continue;
    }

    if (textStart < parsed.start) {
      segments.push({ type: 'text', text: text.slice(textStart, parsed.start) });
    }

    segments.push({
      type: 'link',
      key: `${parsed.start}:${parsed.end}:${parsed.token.raw ?? parsed.token.target}`,
      displayText: displayTextForToken(parsed.token),
      token: parsed.token,
      external: hasUriScheme(parsed.token.target),
    });
    cursor = parsed.end;
    textStart = parsed.end;
  }

  if (textStart < text.length) {
    segments.push({ type: 'text', text: text.slice(textStart) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', text }];
}

function parseWikiLink(
  text: string,
  start: number,
): { start: number; end: number; token: LinkReference } | null {
  const end = text.indexOf(']]', start + 2);

  if (end === -1) {
    return null;
  }

  const raw = text.slice(start, end + 2);
  const content = text.slice(start + 2, end).trim();
  const [target, alias] = splitAlias(content);

  if (!target) {
    return null;
  }

  return {
    start,
    end: end + 2,
    token: {
      kind: 'obsidian_wiki',
      raw,
      label: null,
      target,
      alias,
    },
  };
}

function parseMarkdownLink(
  text: string,
  start: number,
  image: boolean,
): { start: number; end: number; token: LinkReference } | null {
  const labelStart = image ? start + 2 : start + 1;
  const labelEnd = text.indexOf(']', labelStart);

  if (labelEnd === -1 || text[labelEnd + 1] !== '(') {
    return null;
  }

  const targetEnd = text.indexOf(')', labelEnd + 2);

  if (targetEnd === -1) {
    return null;
  }

  const raw = text.slice(start, targetEnd + 1);
  const label = text.slice(labelStart, labelEnd).trim();
  const target = text.slice(labelEnd + 2, targetEnd).trim();

  if (!target) {
    return null;
  }

  return {
    start,
    end: targetEnd + 1,
    token: {
      kind: image ? 'image' : 'standard_markdown',
      raw,
      label: label || null,
      target,
      alias: null,
    },
  };
}

function findNextMarkdownLinkStart(text: string, cursor: number): number {
  let current = cursor;

  while (current < text.length) {
    const index = text.indexOf('[', current);

    if (index === -1) {
      return -1;
    }

    if (text[index + 1] !== '[' && text[index - 1] !== '!') {
      return index;
    }

    current = index + 1;
  }

  return -1;
}

function findNextImageLinkStart(text: string, cursor: number): number {
  let current = cursor;

  while (current < text.length) {
    const index = text.indexOf('![', current);

    if (index === -1) {
      return -1;
    }

    if (text[index + 2] !== '[') {
      return index;
    }

    current = index + 1;
  }

  return -1;
}

function firstNonNegative(values: number[]): number {
  const matches = values.filter((value) => value >= 0);
  return matches.length === 0 ? -1 : Math.min(...matches);
}

function splitAlias(value: string): [string, string | null] {
  const aliasIndex = value.indexOf('|');

  if (aliasIndex === -1) {
    return [value.trim(), null];
  }

  return [value.slice(0, aliasIndex).trim(), value.slice(aliasIndex + 1).trim() || null];
}

function displayTextForToken(token: LinkReference): string {
  if (token.alias) {
    return token.alias;
  }

  if (token.label) {
    return token.label;
  }

  return token.target;
}

function hasUriScheme(target: string): boolean {
  const schemeEnd = target.indexOf(':');

  if (schemeEnd <= 0) {
    return false;
  }

  if (schemeEnd === 1 && /^[A-Za-z]:/.test(target)) {
    return false;
  }

  const scheme = target.slice(0, schemeEnd);
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme);
}
