import type {
  AiContextSnapshot,
} from '../ai-assistant/types';

export type AiContextPreviewState =
  | { status: 'idle'; snapshot: null; error: null }
  | { status: 'loading'; snapshot: AiContextSnapshot | null; error: null }
  | { status: 'ready'; snapshot: AiContextSnapshot; error: null }
  | { status: 'error'; snapshot: null; error: string };

export const emptyAiContextPreviewState: AiContextPreviewState = {
  status: 'idle',
  snapshot: null,
  error: null,
};
