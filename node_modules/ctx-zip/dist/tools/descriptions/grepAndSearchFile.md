Search a single file using grep-style matching. Returns matching lines with their line numbers. This tool is for searching, not for reading entire file contents. IMPORTANT: This tool can ONLY be used when data was previously written to storage and announced with a "Written to ..." message in this conversation.

CRITICAL: Do not use this tool unless you can find a "Written to ..." message:
- Look for messages that say "Written to file: <path>. Key: <key>. Use the read/search tools to inspect its contents."
- Look for messages that say "Written to storage: <path>. Key: <key>. Use the read/search tools to inspect its contents."
- If you cannot find such a message, DO NOT use this tool. The data has not been persisted to searchable storage.
- Never use email IDs, message IDs, or any other identifiers as keys - these are not storage keys.

If no "Written to ..." message exists, you cannot search the data. Instead, explain that the data needs to be persisted first before it can be searched.

 Inputs:
 - `key`: Relative object path (no scheme). Example: `out/2024-09-01.txt` or `2024/09/01/run-1.txt`.
 - `pattern`: JavaScript regex pattern (without slashes).
 - `flags` (optional): Regex flags, e.g., `i`, `m`, `g`.

 Validity rules (search only actual persisted files/objects):
 - Only search targets that were persisted and announced via "Written to ..." or referenced via "Read from storage ...".
 - Do not search opaque IDs such as email/message IDs or API/database identifiers (e.g., `msg_...`, `msd_...`, `fc_...`, `itemId`, UUIDs without a path). These are not storage keys.
 - If you only have such an ID and not a `key`, re-run the original producing tool to persist the data and then use the returned "Written to ..." message to obtain a valid `key`.

 Notes:
 - Keys are resolved against the configured storage's base path/prefix.
 - If your object path contains subfolders, include them in `key` (e.g., `logs/2024/09/01.txt`).