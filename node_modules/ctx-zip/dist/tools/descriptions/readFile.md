Read the full contents of a single file from storage. This is not a search tool. IMPORTANT: This tool can ONLY be used when data was previously written to storage and announced with a "Written to ..." message in this conversation.

CRITICAL: Do not use this tool unless you can find a "Written to ..." message:
- Look for messages that say "Written to file: <path>. Key: <key>. Use the read/search tools to inspect its contents."
- Look for messages that say "Written to storage: <path>. Key: <key>. Use the read/search tools to inspect its contents."
- If you cannot find such a message, DO NOT use this tool. The data has not been persisted to readable storage.
- Never use email IDs, message IDs, or any other identifiers as keys - these are not storage keys.

If no "Written to ..." message exists, you cannot read the data. Instead, explain that the data needs to be persisted first before it can be read.

Inputs:
- `key`: Relative object path (no scheme). Example: `out/2024-09-01.txt` or `2024/09/01/run-1.txt`.

Notes:
- Keys are resolved against the configured storage's base path/prefix.
- If your object path contains subfolders, include them in `key` (e.g., `logs/2024/09/01.txt`).