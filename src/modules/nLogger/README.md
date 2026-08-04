# Logger Module

Zero-dependency logging utility for Node.js projects.

## Usage as Git Submodule

### 1. Add to your project

```bash
# In your project root
git submodule add https://github.com/YOUR_USERNAME/logger.git vendor/logger
git submodule update --init --recursive
```

### 2. Create a wrapper (recommended)

Create `src/utils/logger.js` in your project:

```javascript
// src/utils/logger.js
// Wrapper for the logger submodule

import { createLogger, getLogger, resetLogger } from '../../vendor/logger/src/logger.js';

export { createLogger, getLogger, resetLogger };
```

### 3. Use in your code

```javascript
import { getLogger } from './utils/logger.js';

const logger = getLogger();

logger.info('Server started', { port: 3000 }, 'System');
logger.error('Database failed', err, null, 'Database');
```

## Updating the Logger

```bash
# Update to latest
cd vendor/logger
git pull origin main
cd ../..
git add vendor/logger
git commit -m "Update logger submodule"
```

## Project Structure

```
your-project/
├── src/
│   └── utils/
│       └── logger.js      # Wrapper that imports from submodule
├── vendor/                # Git submodules
│   └── logger/
│       └── src/
│           └── logger.js  # The actual logger
└── logs/                  # Log output directory
```

## Configuration

Environment variables:

```bash
LOG_RETENTION_DAYS=7    # Days to keep old logs (default: 1)
DEBUG=true              # Enable debug logging
NODE_ENV=development    # Also enables debug logging
```

## Log Format

### Session Logs

Session files are created for each application run. One file per session.

```
[2026-03-22T14:33:26.713Z] [INFO] [ModelRouter] Message {"key":"value"}
```

Format: `[timestamp] [LEVEL] [TYPE] message {JSON metadata}`

### Main Logs (Combined Rolling Log)

All entries are also written to a combined rolling log in JSON Lines format.

```
{"ts":"2026-03-22T14:33:26.713Z","level":"INFO","type":"ModelRouter","msg":"Message","meta":{"key":"value"},"session":"gw-1ixp0h"}
```

Format: JSON with `ts`, `level`, `type`, `msg`, `meta`, and `session` fields.

The main log rolls by size (default 10MB) into `main-0.log`, `main-1.log`, etc. Use `jq` to parse:

```bash
cat logs/main-0.log | jq 'select(.level == "ERROR")'
cat logs/main-0.log | jq 'select(.session == "gw-1ixp0h")'
```

## Configuration

### Environment Variables

```bash
LOG_RETENTION_DAYS=7    # Days to keep session logs (default: 1)
DEBUG=true              # Enable debug logging
NODE_ENV=development    # Also enables debug logging
```

### Constructor Options

```javascript
createLogger({
    logsDir: '/path/to/logs',           # Log directory (default: ../../logs)
    sessionPrefix: 'gw',                 # Session ID prefix (default: 'gw')

    // Combined rolling log options
    enableMainLog: true,                # Enable main log (default: true)
    mainLogPrefix: 'main',               # Main log prefix (default: 'main')
    maxFileSizeBytes: 10 * 1024 * 1024, # Max size per main log file (default: 10MB)
    maxMainLogFiles: 10,                # Max main log files to keep (default: 10)
    flushIntervalMs: 1000,               # Force flush interval (default: 1000ms)
})
```

## Log File Structure

```
logs/
├── 2026-03-22-08-57-55-gw-1ixp0h.log   # Session file (one per session)
├── 2026-03-22-14-30-00-gw-2klmnp.log   # Another session
├── main-0.log                           # Current main log (combined)
├── main-1.log                           # Older main log
├── main-2.log                           # Even older
└── ...
```

- **Session files**: Auto-deleted after `LOG_RETENTION_DAYS`
- **Main logs**: Rolling by size, oldest pruned when exceeding `maxMainLogFiles`
