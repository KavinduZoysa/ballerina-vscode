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
import { parse } from '@iarna/toml';

// The configurables live in `workflow.management.rest`, the module that owns the HTTP listener.
const TABLE = 'ballerina.workflow.management.rest';
const KEY = 'enableManagementApi';
// An earlier toggle wrote these under `ballerina.workflow.management`, where none of them is a
// configurable, so they are cleared from there whenever the toggle runs.
const STALE_TABLE = 'ballerina.workflow.management';
const STALE_KEYS = [KEY, 'port', 'enableBasicAuth'];

const ALREADY_TRUE = /=[ \t]*true[ \t]*(?:#[^\r\n]*)?\r?$/;
// Captures around the value so a flip rewrites it alone, leaving any trailing comment.
const VALUE = /^([ \t]*[\w.]+[ \t]*=[ \t]*)("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^#\r\n]*?)([ \t]*(?:#[^\r\n]*)?\r?)$/;

const LOG = '[WorkflowManagement]';

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

function withManagementApi(original: string, enabled: boolean): string {
    const content = dropStaleKeys(original);
    const table = findTable(content, TABLE);
    const key = table && keyLine(KEY).exec(table.body);

    if (!key) {
        return enabled ? appendKey(original, content, table) : content;
    }

    const start = table.bodyStart + key.index;
    const end = start + key[0].length;
    if (enabled) {
        return ALREADY_TRUE.test(key[0])
            ? content
            : content.slice(0, start) + key[0].replace(VALUE, '$1true$3') + content.slice(end);
    }
    return dropTableIfEmpty(content.slice(0, start) + content.slice(Math.min(end + 1, content.length)), TABLE);
}

interface Table {
    headerStart: number;
    bodyStart: number;
    body: string;
}

function keyLine(key: string): RegExp {
    return new RegExp(`^[ \\t]*${key}[ \\t]*=[^\\n]*$`, 'm');
}

function findTable(content: string, name: string): Table | undefined {
    const header = new RegExp(`^[ \\t]*\\[${name.replace(/\./g, '\\.')}\\][ \\t]*(?:#[^\\r\\n]*)?$`, 'm')
        .exec(content);
    if (!header) {
        return undefined;
    }
    const newline = content.indexOf('\n', header.index + header[0].length);
    const bodyStart = newline === -1 ? content.length : newline + 1;
    const rest = content.slice(bodyStart);
    const next = /^[ \t]*\[/m.exec(rest);
    return { headerStart: header.index, bodyStart, body: next ? rest.slice(0, next.index) : rest };
}

function appendKey(original: string, content: string, table: Table | undefined): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    if (table) {
        const head = content.slice(0, table.bodyStart);
        const separator = head === '' || head.endsWith('\n') ? '' : eol;
        return head + separator + `${KEY} = true${eol}` + content.slice(table.bodyStart);
    }
    // The header regex only knows the plain spelling. A table the author wrote another way — as
    // dotted keys, say — must not be defined a second time, which TOML rejects, so the file is
    // parsed once to be sure it is not there, and left alone when that cannot be established.
    const declared = declaresRestTable(content);
    if (declared === undefined) {
        console.error(`${LOG} Config.toml could not be parsed; leaving it unchanged`);
        return original;
    }
    if (declared) {
        console.error(`${LOG} Config.toml already declares ${TABLE} in a form this editor does not rewrite; `
            + `set ${KEY} = true there by hand`);
        return original;
    }
    let out = content;
    if (out.length > 0 && !out.endsWith('\n')) { out += eol; }
    if (out.length > 0 && !out.endsWith('\n\n') && !out.endsWith('\r\n\r\n')) { out += eol; }
    return out + `[${TABLE}]${eol}${KEY} = true${eol}`;
}

function declaresRestTable(content: string): boolean | undefined {
    try {
        const parsed = parse(content) as Record<string, any>;
        return parsed?.ballerina?.workflow?.management?.rest !== undefined;
    } catch {
        return undefined;
    }
}

function dropStaleKeys(content: string): string {
    const table = findTable(content, STALE_TABLE);
    if (!table) {
        return content;
    }
    let body = table.body;
    for (const key of STALE_KEYS) {
        body = body.replace(new RegExp(`^[ \\t]*${key}[ \\t]*=[^\\n]*\\n?`, 'm'), '');
    }
    if (body === table.body) {
        return content;
    }
    const updated = content.slice(0, table.bodyStart) + body + content.slice(table.bodyStart + table.body.length);
    return dropTableIfEmpty(updated, STALE_TABLE);
}

function dropTableIfEmpty(content: string, name: string): string {
    const table = findTable(content, name);
    if (!table || table.body.trim() !== '') {
        return content;
    }
    return content.slice(0, table.headerStart) + content.slice(table.bodyStart + table.body.length);
}
