// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

// Import-light on purpose: unit tests load this without the language-server chain.

export interface CollectedBalFile {
    relPath: string;
    lineCount: number;
}

const CODEBASE_MAP_INTRO =
    "This is a map of the codebase — file paths, line counts, and top-level declarations only; " +
    "file bodies are not included. Use `file_read` to read a file before editing it.";

export function formatCodebaseMap(files: CollectedBalFile[], declarations?: Map<string, string[]>): string {
    const fileLines = files.map(file => {
        const decls = declarations?.get(file.relPath);
        const declText = decls && decls.length > 0 ? decls.join("; ") : undefined;
        return declText
            ? `<file path="${file.relPath}" lines="${file.lineCount}">${declText}</file>`
            : `<file path="${file.relPath}" lines="${file.lineCount}"/>`;
    });
    return [`<codebase_map>`, CODEBASE_MAP_INTRO, ...fileLines, `</codebase_map>`].join("\n");
}

const SOURCE_INVENTORY_MARKER = "SOURCE INVENTORY";

export function extractPreviousStageWorkPlan(transcript: string): string {
    const lines = transcript.split("\n");
    const markerIndex = lines.findIndex(line => line.includes(SOURCE_INVENTORY_MARKER));
    if (markerIndex === -1) {
        return transcript.trim();
    }
    return lines.slice(markerIndex).join("\n").trim();
}
