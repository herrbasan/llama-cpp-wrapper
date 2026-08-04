# Logger Module Setup Guide

## Quick Start

### 1. Create the Logger Repository

Create a new GitHub repo (e.g., `yourusername/logger`), then:

```bash
# Clone this template
cd logger-module-plan

# Initialize git repo
git init
git add .
git commit -m "Initial logger implementation"

# Push to GitHub
git remote add origin https://github.com/YOUR_USERNAME/logger.git
git branch -M main
git push -u origin main
```

### 2. Add to Your Projects

**In each project that needs the logger:**

```bash
# Add as submodule
git submodule add https://github.com/YOUR_USERNAME/logger.git vendor/logger
git submodule update --init --recursive

# Create wrapper
mkdir -p src/utils
cat > src/utils/logger.js << 'EOF'
import { createLogger, getLogger, resetLogger } from '../../vendor/logger/src/logger.js';
export { createLogger, getLogger, resetLogger };
EOF

# Add logs to gitignore
echo "logs/" >> .gitignore

# Commit
git add vendor/logger src/utils/logger.js .gitignore
git commit -m "Add logger submodule"
```

### 3. Usage

```javascript
import { getLogger } from './utils/logger.js';

const logger = getLogger();

logger.info('Server starting', { port: 3000 }, 'System');
logger.warn('High memory usage', { used: '85%' }, 'Monitor');
logger.error('DB connection failed', error, null, 'Database');
```

## Project Structure After Setup

```
my-project/
├── src/
│   └── utils/
│       └── logger.js       # Thin wrapper
├── vendor/                 # Git submodules
│   └── logger/
│       ├── src/
│       │   └── logger.js   # The actual logger
│       └── README.md
├── logs/                   # Generated log files
├── .gitignore             # Should include: logs/
└── .gitmodules            # Git tracks submodules here
```

## Updating the Logger

```bash
# Update to latest version
cd vendor/logger
git pull origin main
cd ../..
git add vendor/logger
git commit -m "Update logger to latest"
```

## Customizing Per Project

Each project can customize via environment variables:

```bash
# .env file
LOG_RETENTION_DAYS=7       # Keep session logs for 7 days
DEBUG=true                 # Enable debug logging
```

Or by passing options to `createLogger()`:

```javascript
import { createLogger } from './utils/logger.js';

const logger = createLogger({
    logsDir: '/custom/log/path',
    sessionPrefix: 'mcp',  // Changes session IDs from "gw-xxx" to "mcp-xxx"

    // Combined rolling log options (enabled by default)
    enableMainLog: true,               // Set to false to disable
    mainLogPrefix: 'main',            // Files: main-0.log, main-1.log, etc.
    maxFileSizeBytes: 10 * 1024 * 1024, // 10MB per main log file
    maxMainLogFiles: 10,              // Keep last 10 main logs
});
```

**Combined Rolling Log**: All log entries are written to rolling main log files (`main-0.log`, `main-1.log`, etc.) in JSON Lines format. Each entry includes a `session` field so you can filter by session. Session logs remain unchanged (one file per session, auto-deleted by retention). See README for details.

## Cloning a Project with Submodules

```bash
# Clone with submodules
git clone --recursive https://github.com/YOUR_USERNAME/my-project.git

# Or if already cloned:
git submodule update --init --recursive
```

## Troubleshooting

### Submodule shows as empty directory

```bash
git submodule update --init --recursive
```

### Want to modify the logger

Since it's your repo, you can:

```bash
cd vendor/logger
# Make changes
git add .
git commit -m "Add feature"
git push origin main
```

Then update in other projects:
```bash
cd vendor/logger && git pull origin main
```

### Detached HEAD in submodule

```bash
cd vendor/logger
git checkout main
git pull origin main
```

## Benefits of This Approach

1. **Zero npm dependencies** - Everything is your own code
2. **Easy enhancement** - Modify logger while working on projects
3. **Single source** - Changes propagate to all projects
4. **Version control** - Git tracks exact versions used
5. **Offline work** - Submodule is local after initial clone
