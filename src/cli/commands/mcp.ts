import { spawn } from 'child_process';
import path from 'path';
import { errorMessage } from '../services.js';
import * as ui from '../ui.js';

export function showConfig() {
  const config = {
    mcpServers: {
      backbeat: {
        command: 'npx',
        args: ['-y', 'backbeat', 'mcp', 'start'],
      },
    },
  };

  ui.note(
    `Add this to your MCP configuration file:

${JSON.stringify(config, null, 2)}

Configuration file locations:
  Claude Code: .mcp.json (in project root)
  Claude Desktop (macOS): ~/Library/Application Support/Claude/claude_desktop_config.json
  Claude Desktop (Windows): %APPDATA%\\Claude\\claude_desktop_config.json

For local development:
{
  "mcpServers": {
    "backbeat": {
      "command": "node",
      "args": ["/path/to/backbeat/dist/index.js"]
    }
  }
}

For global installation:
{
  "mcpServers": {
    "backbeat": {
      "command": "beat",
      "args": ["mcp", "start"]
    }
  }
}

Learn more: https://github.com/dean0x/delegate#configuration`,
    'MCP Configuration',
  );
}

export function handleMcpStart(dirname: string) {
  const indexPath = path.join(dirname, 'index.js');
  import(indexPath)
    .then((module) => {
      if (module.main) {
        return module.main();
      }
      ui.error('MCP server module does not export main()');
      process.exit(1);
    })
    .catch((error) => {
      ui.error(`Failed to start MCP server: ${errorMessage(error)}`);
      process.exit(1);
    });
}

export function handleMcpTest(dirname: string) {
  const s = ui.createSpinner();
  s.start('Testing MCP server startup...');

  const indexPath = path.join(dirname, 'index.js');
  const mcp = spawn('node', [indexPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  let hasError = false;

  mcp.stdout?.on('data', (data) => {
    output += data.toString();
  });
  mcp.stderr?.on('data', (data) => {
    output += data.toString();
  });

  mcp.on('error', (err) => {
    s.stop('Test failed');
    ui.error(`Failed to start server: ${err.message}`);
    hasError = true;
  });

  mcp.on('exit', (code) => {
    if (hasError) {
      process.exit(1);
    }
    if (code !== 0 && code !== null) {
      s.stop('Test failed');
      ui.error(`Server exited with non-zero code: ${code}`);
      process.exit(1);
    }
  });

  setTimeout(() => {
    if (output.includes('Starting Backbeat MCP Server') && !hasError) {
      s.stop('Server started successfully');
      ui.success('Bootstrap completed without errors');
      mcp.kill();
      process.exit(0);
    } else {
      s.stop('Test failed');
      ui.error('Server failed to start properly');
      mcp.kill();
      process.exit(1);
    }
  }, 5000);
}
