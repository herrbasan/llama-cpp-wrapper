/**
 * Zero-dependency logging utility
 *
 * Features:
 * - Timestamped session log files (one per session)
 * - Combined rolling main log (main-0.log = current, main-1.log, main-2.log, etc.)
 * - JSON Lines format for main log (machine-parseable)
 * - Structured log format with event types
 * - Automatic log rotation by size (ring-buffer: main-0.log → main-1.log → main-2.log)
 * - Multiple log levels (INFO, WARN, ERROR, DEBUG)
 * - JSON metadata support
 * - Write buffering for better I/O performance
 * - Automatic binary/base64 data sanitization (prevents log bloat from image/audio data)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_LOG_RETENTION_DAYS = 1;
const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_MAIN_LOG_FILES = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

// Log levels. The gateway logs at info by default (startup, lifecycle,
// stream start/end telemetry). Set LOG_LEVEL=error for errors-only, or
// =debug when actively working on it. minLevel is runtime-settable.
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveInitialLevel() {
    const raw = (process.env.LOG_LEVEL || '').toLowerCase();
    return raw in LEVELS ? raw : 'info';
}

// Binary field names that commonly contain large base64 data
const BINARY_FIELDS = ['b64_json', 'base64', 'bytesBase64Encoded', 'inlineData', 'data', 'buffer', 'blob'];
const BINARY_PLACEHOLDER = '[BINARY_DATA]';
const LONG_STRING_THRESHOLD = 500;
const TRUNCATE_TO_LENGTH = 200;

/**
 * Logger class - handles file-based logging with structured formatting
 */
class Logger {
    /**
     * @param {object} options
     * @param {string} options.logsDir - Directory for log files (default: ../../logs relative to this file)
     * @param {string} options.sessionPrefix - Prefix for session ID (default: 'gw')
     * @param {boolean} options.enableMainLog - Enable combined rolling log (default: true)
     * @param {string} options.mainLogPrefix - Prefix for main log files (default: 'main')
     * @param {number} options.maxFileSizeBytes - Max size per main log file (default: 10MB)
     * @param {number} options.maxMainLogFiles - Max main log files to keep (including main-0.log; default: 10)
     * @param {number} options.flushIntervalMs - Force flush interval (default: 1000ms)
     */
    constructor(options = {}) {
        // Resolve from project root (submodule is at src/nLogger/src/logger.js)
        this.logsDir = options.logsDir || path.resolve(__dirname, '../../../logs');
        this.sessionPrefix = options.sessionPrefix || 'gw';

        // Main log options
        this.enableMainLog = options.enableMainLog !== false;
        this.mainLogPrefix = options.mainLogPrefix || 'main';
        this.maxFileSizeBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES;
        this.maxMainLogFiles = options.maxMainLogFiles || DEFAULT_MAX_MAIN_LOG_FILES;
        this.flushIntervalMs = options.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;

        this.logFile = null;
        this.logStream = null;
        this.startTime = new Date();
        this.sessionId = this._generateSessionId();
        this.logRetentionDays = this._resolveLogRetentionDays();

        // Minimum level for a message to be written. Runtime-settable via setLevel().
        this.minLevel = resolveInitialLevel();

        // Main log state
        this._mainLogBuffer = [];
        this._mainLogCurrentSize = 0;
        this._mainLogStream = null;
        this._flushTimer = null;
        this._drainListenerAdded = false;

        this._initializeLogFile();

        if (this.enableMainLog) {
            this._initializeMainLog();
        }
    }
    
    /**
     * Set the minimum log level at runtime ('debug'|'info'|'warn'|'error').
     * Returns the level actually set (throws on an unknown level).
     */
    setLevel(level) {
        const normalized = String(level || '').toLowerCase();
        if (!(normalized in LEVELS)) {
            throw new Error(`Unknown log level: "${level}". Must be one of: ${Object.keys(LEVELS).join(', ')}`);
        }
        const previous = this.minLevel;
        this.minLevel = normalized;
        this._writeToFile(`[${new Date().toISOString()}] [INFO] [System] Log level changed: ${previous} -> ${normalized}`);
        return normalized;
    }

    getLevel() {
        return this.minLevel;
    }

    _shouldWrite(level) {
        return LEVELS[level] >= LEVELS[this.minLevel];
    }

    _generateSessionId() {
        return `${this.sessionPrefix}-${Date.now().toString(36).slice(-6)}`;
    }

    _isLongBase64(value) {
        // Cheap length gate first: a string must exceed the threshold before it
        // can be 'long base64'. Short-circuiting here avoids running the full
        // regex scan on every string ≥100 chars (the common hot-path case).
        if (typeof value !== 'string' || value.length <= LONG_STRING_THRESHOLD) return false;
        // Base64 pattern: alphanumeric with +/= at end
        const base64Pattern = /^[A-Za-z0-9+/=]+$/;
        return base64Pattern.test(value);
    }

    _sanitizeValue(value) {
        if (value === null || value === undefined) return value;

        if (typeof value === 'string') {
            if (this._isLongBase64(value)) {
                return `${BINARY_PLACEHOLDER}(${value.length} chars)`;
            }
            if (value.length > LONG_STRING_THRESHOLD) {
                return value.substring(0, TRUNCATE_TO_LENGTH) + `... [${value.length} chars total]`;
            }
            return value;
        }

        if (typeof value === 'number' || typeof value === 'boolean') return value;

        if (Array.isArray(value)) {
            return value.map(item => this._sanitizeValue(item));
        }

        if (typeof value === 'object') {
            const sanitized = {};
            for (const [key, val] of Object.entries(value)) {
                if (BINARY_FIELDS.includes(key) && typeof val === 'string' && val.length > 100) {
                    sanitized[key] = `${BINARY_PLACEHOLDER}(${val.length} chars)`;
                } else {
                    sanitized[key] = this._sanitizeValue(val);
                }
            }
            return sanitized;
        }

        return value;
    }

    _sanitizeMeta(meta) {
        if (!meta || typeof meta !== 'object') return {};
        // Fast path: if no value could possibly need sanitizing (no long strings,
        // no binary fields, no nested objects/arrays), return meta as-is and skip
        // the deep-copy entirely. This is the common hot-path case.
        let needsSanitize = false;
        for (const val of Object.values(meta)) {
            if (typeof val === 'string' && val.length > 100) { needsSanitize = true; break; }
            if (val !== null && typeof val === 'object') { needsSanitize = true; break; }
        }
        if (!needsSanitize) return meta;
        return this._sanitizeValue(meta);
    }

    _sanitizeMessage(message) {
        if (typeof message !== 'string') return message;
        // Single pass: replace CR/LF/TAB runs with the desired output directly,
        // then collapse remaining whitespace. Replaces 5 sequential regex scans.
        return message
            .replace(/\r\n|[\n\r]|\t/g, (m) => (m === '\t' ? '    ' : '\\n'))
            .replace(/ {2,}/g, ' ')
            .trim();
    }

    _initializeLogFile() {
        // Ensure logs directory exists
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }

        this._pruneOldLogs();
        
        // Create timestamped filename: YYYY-MM-DD-HH-MM-SS-<prefix>-<sessionId>.log
        const timestamp = this.startTime.toISOString()
            .replace(/[:T]/g, '-')
            .slice(0, 19);
        const filename = `${timestamp}-${this.sessionId}.log`;
        this.logFile = path.join(this.logsDir, filename);
        
        // Create write stream (append mode)
        this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
        
        // Write startup header
        this._writeToFile(`\n========================================`);
        this._writeToFile(`Session: ${this.sessionId}`);
        this._writeToFile(`Started: ${this.startTime.toISOString()}`);
        this._writeToFile(`Log File: ${this.logFile}`);
        this._writeToFile(`Retention Days: ${this.logRetentionDays}`);
        this._writeToFile(`========================================\n`);
    }

    _resolveLogRetentionDays() {
        const rawValue = process.env.LOG_RETENTION_DAYS;
        if (rawValue == null || rawValue === '') {
            return DEFAULT_LOG_RETENTION_DAYS;
        }
        const parsed = Number(rawValue);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOG_RETENTION_DAYS;
    }

    _pruneOldLogs() {
        if (this.logRetentionDays <= 0) return;

        const cutoffMs = this.startTime.getTime() - (this.logRetentionDays * 24 * 60 * 60 * 1000);

        try {
            const entries = fs.readdirSync(this.logsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
                // Main log files are managed by _pruneMainLogs with a count-based policy
                // Main log files are managed by _pruneMainLogs with a count-based policy
                if (entry.name.startsWith(`${this.mainLogPrefix}-`)) continue;

                const filePath = path.join(this.logsDir, entry.name);
                const stats = fs.statSync(filePath);
                if (stats.mtimeMs < cutoffMs) {
                    fs.unlinkSync(filePath);
                }
            }
        } catch (error) {
            // Log retention failures should not stop the app
            const fallback = `[${new Date().toISOString()}] [WARN] [System] Failed to prune old logs ${JSON.stringify({ error: error.message })}`;
            if (this.logStream) {
                this._writeToFile(fallback);
            }
        }
    }

    // ==================== Main Log (Rolling) ====================
    //
    // Naming convention (ring buffer, conventional rotation):
    //   main-0.log  = current active file (always the newest)
    //   main-1.log  = most recently rolled
    //   main-2.log  = second most recently rolled
    //   ...
    //   main-N.log  = oldest (higher number = older)

    _initializeMainLog() {
        const mainPath = this._mainLogPath();
        try {
            const stats = fs.statSync(mainPath);
            if (stats.size >= this.maxFileSizeBytes) {
                this._rotateMainLogs();
            }
        } catch {
        // No main-0.log — check for orphaned old-format files and clean up
            this._migrateOldMainLogs();
        }
        this._openMainLogStream();
        this._pruneMainLogs();
        this._flushTimer = setInterval(() => this._flushBuffer(), this.flushIntervalMs);
        // Don't let the flush timer keep the process alive on its own.
        this._flushTimer.unref();
    }

    // Migrate old monotonically-incrementing main-N.log files into the ring buffer.
    // Old scheme: main-0.log (oldest) ... main-N.log (newest), higher index = newer.
    // New scheme: main-0.log (current), main-1.log (most recent rotated), higher index = older.
    // Sort by mtime (most recent first) and remap into the ring buffer, preserving history.
    _migrateOldMainLogs() {
        try {
            const entries = fs.readdirSync(this.logsDir);
            const regex = new RegExp(`^${this.mainLogPrefix}-(\\d+)\\.log$`);
            const oldFiles = [];
            for (const name of entries) {
                const match = name.match(regex);
                if (match) {
                    const fullPath = path.join(this.logsDir, name);
                    try {
                        const stat = fs.statSync(fullPath);
                        oldFiles.push({
                            name,
                            path: fullPath,
                            mtime: stat.mtimeMs
                        });
                    } catch {
                        // Skip unreadable files
                    }
                }
            }
            if (oldFiles.length === 0) return;

            // Sort by mtime descending: most recent first → becomes main-0.log
            oldFiles.sort((a, b) => b.mtime - a.mtime);

            let remapped = 0;
            const maxRotated = this.maxMainLogFiles - 1;

            for (let i = 0; i < oldFiles.length; i++) {
                let targetName;
                if (i === 0) {
                    targetName = `${this.mainLogPrefix}-0.log`;
                } else if (i <= maxRotated) {
                    targetName = `${this.mainLogPrefix}-${i}.log`;
                } else {
                    // Beyond capacity — delete
                    fs.unlinkSync(oldFiles[i].path);
                    remapped++;
                    continue;
                }
                const targetPath = path.join(this.logsDir, targetName);
                // If target already exists (e.g. old & new formats mixed), remove it first
                if (fs.existsSync(targetPath) && targetPath !== oldFiles[i].path) {
                    fs.unlinkSync(targetPath);
                }
                if (oldFiles[i].path !== targetPath) {
                    fs.renameSync(oldFiles[i].path, targetPath);
                }
                remapped++;
            }

            this._writeToFile(
                `[${new Date().toISOString()}] [INFO] [System] Migrated ${remapped} log file(s) from old naming scheme into ring buffer`
            );
        } catch {
            // Best-effort — never block startup for cleanup
        }
    }

    _mainLogPath() {
        return path.join(this.logsDir, `${this.mainLogPrefix}-0.log`);
    }

    _openMainLogStream() {
        const filePath = this._mainLogPath();
        this._mainLogStream = fs.createWriteStream(filePath, { flags: 'a' });

        try {
            const stats = fs.statSync(filePath);
            this._mainLogCurrentSize = stats.size;
        } catch {
            this._mainLogCurrentSize = 0;
        }
    }

    _writeToMainLog(level, type, message, meta) {
        const entry = {
            ts: new Date().toISOString(),
            level,
            type,
            // Sanitize for JSONL: raw newlines would break one-line-per-entry.
            msg: this._sanitizeMessage(message),
            meta: Object.keys(meta).length > 0 ? meta : undefined,
            session: this.sessionId
        };

        let line = JSON.stringify(entry) + '\n';
        const lineBytes = Buffer.byteLength(line, 'utf8');

        // Handle oversized entries
        if (lineBytes > this.maxFileSizeBytes) {
            entry.msg = entry.msg.substring(0, 1000) + '... [TRUNCATED]';
            line = JSON.stringify(entry) + '\n';
        }

        this._mainLogBuffer.push(line);
        this._mainLogCurrentSize += lineBytes;

        // Auto-flush if buffer is large enough
        if (this._mainLogBuffer.length >= 10) {
            this._flushBuffer();
        }

        this._rollMainLogIfNeeded();
    }

    _flushBuffer() {
        if (this._mainLogBuffer.length === 0 || !this._mainLogStream) {
            return;
        }

        const batch = this._mainLogBuffer.join('');
        const canContinue = this._mainLogStream.write(batch);
        this._mainLogBuffer = [];

        if (!canContinue && !this._drainListenerAdded) {
            this._drainListenerAdded = true;
            this._mainLogStream.once('drain', () => {
                this._drainListenerAdded = false;
            });
        }
    }

    _rollMainLogIfNeeded() {
        if (this._mainLogCurrentSize >= this.maxFileSizeBytes) {
            this._rollMainLog();
        }
    }

    _rollMainLog() {
        if (this._mainLogStream) {
            this._flushBuffer();
            this._mainLogStream.end();
            this._mainLogStream = null;
        }
        this._drainListenerAdded = false;

        this._rotateMainLogs();
        this._openMainLogStream();
        this._pruneMainLogs();
    }

    _rotateMainLogs() {
        // Shift all existing rotated files: main-N.log → main-(N+1).log
        // Process from highest index down to avoid overwrites.
        // Then rename main-0.log → main-1.log.
        try {
            const entries = fs.readdirSync(this.logsDir);
            const regex = new RegExp(`^${this.mainLogPrefix}-(\\d+)\\.log$`);
            const indices = [];
            for (const name of entries) {
                const match = name.match(regex);
                if (match) indices.push(parseInt(match[1], 10));
            }
            indices.sort((a, b) => b - a); // descending

            const maxRotated = this.maxMainLogFiles - 1; // main-0.log doesn't count toward rotated count

            for (const idx of indices) {
                if (idx === 0) continue; // main-0.log handled separately below
                const oldPath = path.join(this.logsDir, `${this.mainLogPrefix}-${idx}.log`);
                if (idx >= maxRotated) {
                    fs.unlinkSync(oldPath);
                } else {
                    const newPath = path.join(this.logsDir, `${this.mainLogPrefix}-${idx + 1}.log`);
                    fs.renameSync(oldPath, newPath);
                }
            }

            // Move main-0.log → main-1.log
            const currentPath = this._mainLogPath();
            if (fs.existsSync(currentPath)) {
                const rotatedPath = path.join(this.logsDir, `${this.mainLogPrefix}-1.log`);
                fs.renameSync(currentPath, rotatedPath);
            }
        } catch (err) {
            // Rotation failure is serious — a main log that never rotates grows
            // unbounded. Surface it loudly to the session log and stderr, never swallow.
            const msg = `[${new Date().toISOString()}] [ERROR] [System] Main log rotation FAILED: ${err.message}`;
            try { this._writeToFile(msg); } catch {}
            try { process.stderr.write(msg + '\n'); } catch {}
        }
    }

    _pruneMainLogs() {
        try {
            const entries = fs.readdirSync(this.logsDir);
            const mainLogs = [];
            const regex = new RegExp(`^${this.mainLogPrefix}-(\\d+)\\.log$`);

            for (const name of entries) {
                const match = name.match(regex);
                if (match) {
                    const idx = parseInt(match[1], 10);
                    if (idx === 0) continue; // main-0.log is current, never pruned here
                    mainLogs.push({
                        name,
                        index: idx,
                        path: path.join(this.logsDir, name)
                    });
                }
            }

            // Sort by index descending (highest = oldest, delete those first)
            mainLogs.sort((a, b) => b.index - a.index);

            // Keep at most maxMainLogFiles - 1 rotated files (main-0.log is the Nth file)
            const keepMax = this.maxMainLogFiles - 1;
            for (let i = keepMax; i < mainLogs.length; i++) {
                fs.unlinkSync(mainLogs[i].path);
            }
        } catch (err) {
            // Prune failure means old logs accumulate forever — surface, don't swallow.
            const msg = `[${new Date().toISOString()}] [WARN] [System] Main log prune FAILED: ${err.message}`;
            try { this._writeToFile(msg); } catch {}
        }
    }

    _closeMainLog() {
        this._flushBuffer();

        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }

        if (this._mainLogStream) {
            this._mainLogStream.end();
            this._mainLogStream = null;
        }
    }

    // ==================== Session Log Write ====================

    _writeToFile(message) {
        if (this.logStream) {
            this.logStream.write(message + '\n');
        }
    }
    
    /**
     * Format a log message
     * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
     * @param {string} type - Event type/category
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    _formatMessage(level, type, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const sanitizedMessage = this._sanitizeMessage(message);
        const metaStr = Object.keys(meta).length > 0 
            ? ' ' + JSON.stringify(meta) 
            : '';
        return `[${timestamp}] [${level}] [${type}] ${sanitizedMessage}${metaStr}`;
    }
    
    /**
     * Log an info message
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    info(message, meta = {}, type = 'System', options = {}) {
        if (!this._shouldWrite('info')) return;
        const safeMeta = this._sanitizeMeta(meta);
        const formatted = this._formatMessage('INFO', type, message, safeMeta);
        this._writeToFile(formatted);
        if (this.enableMainLog) {
            this._writeToMainLog('INFO', type, message, safeMeta);
        }
        if (options.console) {
            console.log(formatted);
        }
    }
    
    /**
     * Log a warning message
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    warn(message, meta = {}, type = 'System', options = {}) {
        if (!this._shouldWrite('warn')) return;
        const safeMeta = this._sanitizeMeta(meta);
        const formatted = this._formatMessage('WARN', type, message, safeMeta);
        this._writeToFile(formatted);
        if (this.enableMainLog) {
            this._writeToMainLog('WARN', type, message, safeMeta);
        }
        if (options.console) {
            console.log(formatted);
        }
    }
    
    /**
     * Log an error message
     * @param {string} message - Log message
     * @param {Error|null} error - Error object
     * @param {object|null} meta - Additional metadata
     * @param {string} type - Event type/category (default: 'System')
     */
    error(message, error = null, meta = null, type = 'System', options = {}) {
        // Errors always log — they bypass the level gate.
        const errorMeta = error ? {
            error: error.message,
            stack: error.stack ? this._sanitizeMessage(error.stack) : undefined,
            ...(meta || {})
        } : (meta || {});
        const safeMeta = this._sanitizeMeta(errorMeta);
        const formatted = this._formatMessage('ERROR', type, message, safeMeta);
        this._writeToFile(formatted);
        if (this.enableMainLog) {
            this._writeToMainLog('ERROR', type, message, safeMeta);
        }
        if (options.console) {
            console.error(formatted);
        }
    }
    
    /**
     * Log a debug message (only in development/DEBUG mode)
     * @param {string} message - Log message
     * @param {object} meta - Metadata object
     * @param {string} type - Event type/category (default: 'System')
     */
    debug(message, meta = {}, type = 'System', options = {}) {
        if (!this._shouldWrite('debug')) return;
        const safeMeta = this._sanitizeMeta(meta);
        const formatted = this._formatMessage('DEBUG', type, message, safeMeta);
        this._writeToFile(formatted);
        if (this.enableMainLog) {
            this._writeToMainLog('DEBUG', type, message, safeMeta);
        }
        if (options.console) {
            console.log(formatted);
        }
    }
    
    /**
     * Get current session info
     * @returns {object} Session info with sessionId, logFile, startedAt
     */
    getSessionInfo() {
        return {
            sessionId: this.sessionId,
            logFile: this.logFile,
            startedAt: this.startTime.toISOString()
        };
    }
    
    /**
     * Close the log stream gracefully
     * @param {string} [shutdownMessage] - Custom shutdown message
     */
    close(shutdownMessage = 'Shutting down') {
        if (this.logStream) {
            const duration = Date.now() - this.startTime.getTime();
            this._writeToFile(`\n[${new Date().toISOString()}] [INFO] [System] ${shutdownMessage}. Session duration: ${Math.round(duration / 1000)}s`);
            this.logStream.end();
            this.logStream = null;
        }

        if (this.enableMainLog) {
            this._closeMainLog();
        }
    }
}

// Singleton instance
let loggerInstance = null;

/**
 * Create a new logger instance (singleton)
 * @param {object} options - Logger options
 * @returns {Logger}
 */
export function createLogger(options = {}) {
    if (!loggerInstance) {
        loggerInstance = new Logger(options);
    }
    return loggerInstance;
}

/**
 * Get the current logger instance
 * @returns {Logger}
 */
export function getLogger() {
    if (!loggerInstance) {
        return createLogger();
    }
    return loggerInstance;
}

/**
 * Reset the logger instance (mainly for testing)
 */
export function resetLogger() {
    if (loggerInstance) {
        loggerInstance.close();
        loggerInstance = null;
    }
}
