import { invoke } from '@tauri-apps/api/core';

import type { PreparedDesktopExport } from '../application/desktopExportWorkflow';
import type { ExportResult } from '../domain/types';
import { createDesktopExportArtifact } from './browserExportArtifacts';

export interface DesktopExportCommandPayload {
  request: PreparedDesktopExport['request'];
  markdownArtifact?: PreparedDesktopExport['markdownArtifact'];
  warnings?: PreparedDesktopExport['warnings'];
}

export type DesktopExportCommand = (
  payload: DesktopExportCommandPayload,
) => Promise<ExportResult>;

export const runDesktopExport: DesktopExportCommand = async (payload) => {
  const artifact = await createDesktopExportArtifact(payload);
  if (!artifact.ok) {
    return artifact.result;
  }

  return invoke<ExportResult>('exportMindMap', {
    request: payload.request,
    artifact: artifact.artifact,
  });
};
