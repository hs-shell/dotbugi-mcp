#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// stdout은 MCP 프로토콜 전용 — 로그는 반드시 stderr로
serveStdio(() => new McpServer({ name: 'dotbugi-mcp', version: '0.1.0' }));
