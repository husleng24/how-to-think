#!/usr/bin/env node

const mode = process.argv[2] ?? 'success';
const option = process.argv[3];

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function fieldFromEnvelope(envelope, label) {
  const match = envelope.match(new RegExp(`^${label}: (.+)$`, 'm'));
  return match?.[1]?.trim() ?? 'unknown';
}

function latestPromptFromEnvelope(envelope) {
  const marker = '\nLatest user prompt:\n';
  const index = envelope.lastIndexOf(marker);
  if (index === -1) {
    return '';
  }

  return envelope.slice(index + marker.length).trim();
}

function priorConversationFromEnvelope(envelope) {
  const priorMarker = '\nPrior conversation:\n';
  const latestMarker = '\nLatest user prompt:\n';
  const start = envelope.indexOf(priorMarker);
  const end = envelope.indexOf(latestMarker);
  if (start === -1 || end === -1 || end <= start) {
    return '';
  }

  return envelope.slice(start + priorMarker.length, end).trim();
}

async function writeConversationResponse(extra = '') {
  const envelope = await readStdin();
  const message = [
    'Mock provider response',
    `Scope: ${fieldFromEnvelope(envelope, 'Scope')}`,
    `Label: ${fieldFromEnvelope(envelope, 'Label')}`,
    `Latest prompt: ${latestPromptFromEnvelope(envelope)}`,
    `Prior conversation: ${priorConversationFromEnvelope(envelope) || '(none)'}`,
    extra,
  ]
    .filter(Boolean)
    .join('\n');

  process.stdout.write(JSON.stringify({ message }));
}

switch (mode) {
  case 'health':
    process.stdout.write('mock-ai-provider 1.0.0\n');
    break;

  case 'success':
    await writeConversationResponse();
    break;

  case 'slow':
    await delay(Number(option ?? 250));
    await writeConversationResponse('Slow mode completed.');
    break;

  case 'timeout':
    await delay(Number(option ?? 5000));
    await writeConversationResponse('Timeout mode completed after delay.');
    break;

  case 'non-zero':
    process.stderr.write('mock provider forced non-zero exit\n');
    process.exit(7);
    break;

  case 'malformed':
    process.stdout.write('{not json');
    break;

  case 'suggestion':
    await readStdin();
    process.stdout.write(
      JSON.stringify({
        message: [
          'Proposed draft rewrite',
          '',
          '- Clarify the selected branch goal.',
          '- Keep the suggestion reviewable before applying.',
        ].join('\n'),
        operations: [
          {
            kind: 'replaceNodeText',
            nodeId: 'plan',
            text: 'Clarified plan',
          },
        ],
      }),
    );
    break;

  case 'long': {
    const bytes = Number(option ?? 4096);
    process.stdout.write('x'.repeat(bytes));
    break;
  }

  default:
    process.stderr.write(`unknown mock-ai-provider mode: ${mode}\n`);
    process.exit(64);
}
