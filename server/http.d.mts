import type { IncomingMessage, ServerResponse } from 'node:http'
export function createWorkspaceApi(root: string): {
  handler(req: IncomingMessage, res: ServerResponse, next: () => void): void
  close(): void
}
