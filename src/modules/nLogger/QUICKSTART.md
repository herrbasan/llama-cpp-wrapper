# Logger Module - Quick Start

Complete setup for using the logger as a Git submodule.

## File Structure in This Plan

```
logger-module-plan/
├── README.md              # Usage documentation
├── SETUP.md              # Detailed setup guide
├── QUICKSTART.md         # This file
├── setup-submodule.sh    # Automated setup script
└── src/
    └── logger.js         # The actual logger implementation
```

## Step 1: Create the Logger Repo

```bash
# Create new directory for the logger repo
mkdir ~/projects/logger
cd ~/projects/logger

# Copy files from this plan
cp -r /path/to/logger-module-plan/src .
cp /path/to/logger-module-plan/README.md .

# Initialize and push
git init
git add .
git commit -m "Initial logger implementation"
git remote add origin https://github.com/YOUR_USERNAME/logger.git
git push -u origin main
```

## Step 2: Add to LLM Gateway

```bash
cd /d/DEV/LLM\ Gateway

# Add submodule
git submodule add https://github.com/YOUR_USERNAME/logger.git vendor/logger

# Create wrapper (replaces existing src/utils/logger.js)
cat > src/utils/logger.js << 'EOF'
import { createLogger, getLogger, resetLogger } from '../../vendor/logger/src/logger.js';
export { createLogger, getLogger, resetLogger };
EOF

# Update .gitignore (if not already there)
if ! grep -q "^logs/$" .gitignore; then
    echo "logs/" >> .gitignore
fi

# Commit
git add vendor/logger src/utils/logger.js .gitignore
git commit -m "Add logger as submodule"
```

## Step 3: Add to MCP Server

```bash
cd /d/DEV/mcp_server

# Add submodule
git submodule add https://github.com/YOUR_USERNAME/logger.git vendor/logger

# Create wrapper
cat > src/utils/logger.js << 'EOF'
import { createLogger, getLogger, resetLogger } from '../../vendor/logger/src/logger.js';
export { createLogger, getLogger, resetLogger };
EOF

# Add to .gitignore
echo "logs/" >> .gitignore

# Commit
git add vendor/logger src/utils/logger.js .gitignore
git commit -m "Add logger as submodule"
```

## Step 4: Add to WebAdmin

Same process as above, adjusting paths as needed for WebAdmin's structure.

## Usage Example

```javascript
import { getLogger } from './utils/logger.js';

const logger = getLogger();

// Basic logging (defaults to 'System' type)
logger.info('Server started', { port: 3000 });

// Typed logging
logger.info('Chat request received', { id: 123 }, 'ChatHandler');
logger.warn('Rate limit approaching', { remaining: 10 }, 'RateLimiter');
logger.error('DB query failed', error, { query: 'SELECT...' }, 'Database');
```

## Making Changes to the Logger

Since you control the logger repo:

```bash
# Edit in any project
cd vendor/logger
# ... make changes to src/logger.js ...
git add .
git commit -m "Add feature X"
git push origin main

# Update other projects
cd /d/DEV/LLM\ Gateway/vendor/logger
git pull origin main

cd /d/DEV/mcp_server/vendor/logger
git pull origin main
```

## What's Different from Current LLM Gateway Logger?

The new logger is **mostly the same** but with these improvements:

1. **Configurable options** via constructor:
   ```javascript
   createLogger({
       logsDir: '/custom/path',
       sessionPrefix: 'mcp'  // Instead of hardcoded 'gw'
   })
   ```

2. **Customizable shutdown message**:
   ```javascript
   logger.close('MCP Server shutting down');
   ```

3. **More resilient** - better error handling during initialization

4. **Combined rolling log** - all sessions written to `main-0.log`, `main-1.log`, etc. in JSON Lines format for log viewers. Each entry tagged with its `sessionId` so you can filter by session. Enabled by default, see README for options.

## Migration from Current Logger

Your current code will work with minimal changes:

```javascript
// Current (in-gateway logger)
import { getLogger } from './utils/logger.js';
const logger = getLogger();
logger.info('Msg', {}, 'Type');

// New (submodule logger) - SAME API!
import { getLogger } from './utils/logger.js';
const logger = getLogger();
logger.info('Msg', {}, 'Type');
```

**Only difference:** The log file naming changes slightly:
- Old: `2026-03-22-08-57-55-gw-1ixp0h.log`
- New: `2026-03-22-08-57-55-gw-1ixp0h.log` (same, customizable via `sessionPrefix`)

## Environment Variables (Same as Before)

```bash
LOG_RETENTION_DAYS=7    # Days to keep logs
DEBUG=true              # Enable debug logging
NODE_ENV=development    # Also enables debug
```

## Cloning Projects with Submodules

When someone clones your project:

```bash
# Option 1: Clone with submodules
git clone --recursive https://github.com/YOUR_USERNAME/llm-gateway.git

# Option 2: Clone then init submodules
git clone https://github.com/YOUR_USERNAME/llm-gateway.git
cd llm-gateway
git submodule update --init --recursive
```

---

**Next:** See `SETUP.md` for more details and troubleshooting.
