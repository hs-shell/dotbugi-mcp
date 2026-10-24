import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { registerSummarizeWeek } from './prompts/summarize-week.js';
import { registerShortcuts } from './prompts/shortcuts.js';
import { registerAsrRemove } from './tools/asr-remove.js';
import { registerAsrTools } from './tools/asr.js';
import { registerListCourses, registerSetCourseTracking } from './tools/courses.js';
import { registerDeleteMaterials } from './tools/delete-materials.js';
import { registerExportIcs } from './tools/export-ics.js';
import { registerGetAssignment } from './tools/get-assignment.js';
import { registerListTasks } from './tools/list-tasks.js';
import { registerReadMaterial } from './tools/read-material.js';
import { registerSetupStatusline } from './tools/setup-statusline.js';
import { registerStorageDirTools } from './tools/storage-dir.js';
import { registerLogin } from './tools/login.js';
import { registerLogout } from './tools/logout.js';
import { registerSyncMaterials } from './tools/sync-materials.js';
import { registerTranscribeVod } from './tools/transcribe-vod.js';

// 버전은 package.json 단일 출처 (src/·dist/ 모두 한 단계 아래라 같은 상대 경로)
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// 서버 인스턴스 생성 — stdio 연결과 분리해 테스트에서 직접 쓸 수 있게 한다
export function createServer(): McpServer {
  const server = new McpServer({ name: 'dotbugi-mcp', version }, { instructions: SERVER_INSTRUCTIONS });
  registerLogin(server);
  registerLogout(server);
  registerListTasks(server);
  registerExportIcs(server);
  registerListCourses(server);
  registerSetCourseTracking(server);
  registerGetAssignment(server);
  registerSyncMaterials(server);
  registerDeleteMaterials(server);
  registerReadMaterial(server);
  registerStorageDirTools(server);
  registerTranscribeVod(server);
  registerSetupStatusline(server);
  registerAsrTools(server);
  registerAsrRemove(server);
  registerSummarizeWeek(server);
  registerShortcuts(server);
  return server;
}
