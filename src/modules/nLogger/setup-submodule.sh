#!/bin/bash

# Setup script for adding logger submodule to a project

set -e

PROJECT_NAME=$1

if [ -z "$PROJECT_NAME" ]; then
    echo "Usage: ./setup-submodule.sh <project-name>"
    echo "Example: ./setup-submodule.sh llm-gateway"
    exit 1
fi

echo "Setting up logger submodule for $PROJECT_NAME..."

# Create vendor directory if it doesn't exist
mkdir -p vendor

# Add submodule
git submodule add https://github.com/YOUR_USERNAME/logger.git vendor/logger

# Create wrapper file
mkdir -p src/utils

cat > src/utils/logger.js << 'EOF'
/**
 * Logger wrapper
 * 
 * Imports from vendor/logger submodule and re-exports.
 * This allows easy switching between submodule and local implementation.
 */

import { createLogger, getLogger, resetLogger } from '../../vendor/logger/src/logger.js';

export { createLogger, getLogger, resetLogger };
EOF

echo "Logger submodule setup complete!"
echo ""
echo "Next steps:"
echo "1. Import the logger in your code:"
echo "   import { getLogger } from './utils/logger.js';"
echo ""
echo "2. Use it:"
echo "   const logger = getLogger();"
echo "   logger.info('Hello', {}, 'System');"
echo ""
echo "3. Add to .gitignore:"
echo "   logs/"
echo ""
echo "4. Commit the submodule:"
echo "   git add vendor/logger src/utils/logger.js"
echo "   git commit -m 'Add logger submodule'"
