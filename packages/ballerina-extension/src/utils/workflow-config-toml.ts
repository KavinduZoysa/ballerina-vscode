/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import * as fs from 'fs';
import * as path from 'path';

// The configurables live in `workflow.management.rest`, the module that owns the HTTP listener.
const TABLE = 'ballerina.workflow.management.rest';
const KEY = 'enableManagementApi';

const TABLE_HEADER = new RegExp(`^[ \\t]*\\[${TABLE.replace(/\./g, '\\.')}\\][ \\t]*(?:#[^\\n]*)?$`, 'm');
const KEY_LINE = new RegExp(`^[ \\t]*${KEY}[ \\t]*=[^\\n]*$`, 'm');
const ALREADY_TRUE = /=[ \t]*true[ \t]*(?:#[^\n]*)?$/;
// Captures up to the `=` so a flip rewrites the value alone, leaving any trailing comment.
const VALUE = /^([ \t]*[\w.]+[ \t]*=)[ \t]*[^\s#]*/;

/**
 * Turns the workflow management REST API on in Config.toml. Edits the file as text so that
 * comments, key order and formatting elsewhere are left byte for byte as the author wrote them.
 * Only `enableManagementApi` is written; every other setting keeps its module default.
 */
export function enableWorkflowManagementConfig(projectPath: string): void {
    const configPath = path.join(projectPath, 'Config.toml');
    const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
    const updated = withManagementApi(content, true);
    if (updated !== content) {
        fs.writeFileSync(configPath, updated, 'utf-8');
    }
}

/** Removes `enableManagementApi`, and the table too once nothing else is left in it. */
export function disableWorkflowManagementConfig(projectPath: string): void {
    const configPath = path.join(projectPath, 'Config.toml');
    if (!fs.existsSync(configPath)) {
        return;
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    const updated = withManagementApi(content, false);
    if (updated !== content) {
        fs.writeFileSync(configPath, updated, 'utf-8');
    }
}

function withManagementApi(content: string, enabled: boolean): string {
    const table = findTable(content);
    const key = table && KEY_LINE.exec(table.body);

    if (!key) {
        return enabled ? appendKey(content, table) : content;
    }

    const start = table.bodyStart + key.index;
    const end = start + key[0].length;
    if (enabled) {
        return ALREADY_TRUE.test(key[0])
            ? content
            : content.slice(0, start) + key[0].replace(VALUE, '$1 true') + content.slice(end);
    }
    return dropTableIfEmpty(content.slice(0, start) + content.slice(Math.min(end + 1, content.length)));
}

interface Table {
    headerStart: number;
    bodyStart: number;
    body: string;
}

function findTable(content: string): Table | undefined {
    const header = TABLE_HEADER.exec(content);
    if (!header) {
        return undefined;
    }
    const newline = content.indexOf('\n', header.index + header[0].length);
    const bodyStart = newline === -1 ? content.length : newline + 1;
    const rest = content.slice(bodyStart);
    const next = /^[ \t]*\[/m.exec(rest);
    return { headerStart: header.index, bodyStart, body: next ? rest.slice(0, next.index) : rest };
}

function appendKey(content: string, table: Table | undefined): string {
    if (table) {
        const head = content.slice(0, table.bodyStart);
        const separator = head === '' || head.endsWith('\n') ? '' : '\n';
        return head + separator + `${KEY} = true\n` + content.slice(table.bodyStart);
    }
    let out = content;
    if (out.length > 0 && !out.endsWith('\n')) { out += '\n'; }
    if (out.length > 0 && !out.endsWith('\n\n')) { out += '\n'; }
    return out + `[${TABLE}]\n${KEY} = true\n`;
}

function dropTableIfEmpty(content: string): string {
    const table = findTable(content);
    if (!table || table.body.trim() !== '') {
        return content;
    }
    return content.slice(0, table.headerStart) + content.slice(table.bodyStart + table.body.length);
}
