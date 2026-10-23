#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

// stdout은 MCP 프로토콜 전용 — 로그는 반드시 stderr로
serveStdio(createServer);
