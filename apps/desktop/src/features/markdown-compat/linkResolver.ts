import { invoke } from '@tauri-apps/api/core';

import type { LinkResolution, ResolveLinkRequest } from './types';

export function resolveWorkspaceLink(request: ResolveLinkRequest): Promise<LinkResolution> {
  return invoke<LinkResolution>('resolve_workspace_link', { request });
}
