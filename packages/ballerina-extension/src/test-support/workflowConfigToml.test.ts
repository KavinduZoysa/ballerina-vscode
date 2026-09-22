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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse } from "@iarna/toml";

import {
    disableWorkflowManagementConfig,
    enableWorkflowManagementConfig,
} from "../utils/workflow-config-toml";

let projectPath: string;
let configPath: string;

beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-config-"));
    configPath = path.join(projectPath, "Config.toml");
});

afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
});

function write(content: string): void {
    fs.writeFileSync(configPath, content, "utf-8");
}

function read(): string {
    return fs.readFileSync(configPath, "utf-8");
}

describe("enableWorkflowManagementConfig", () => {
    it("writes the block under workflow.management.rest, the module that owns the listener", () => {
        enableWorkflowManagementConfig(projectPath);

        const config = parse(read()) as any;
        expect(config.ballerina.workflow.management.rest).toEqual({ enableManagementApi: true });
    });

    it("writes no setting that already has a module default", () => {
        enableWorkflowManagementConfig(projectPath);

        expect(read()).toBe("[ballerina.workflow.management.rest]\nenableManagementApi = true\n");
    });

    it("leaves every other line, comment and number format untouched", () => {
        const original = [
            "# Deployment settings — keep in sync with the chart.",
            "[ballerina.workflow]",
            'mode = "LOCAL"   # in-memory for local runs',
            "port = 8234",
            "",
        ].join("\n");
        write(original);

        enableWorkflowManagementConfig(projectPath);

        expect(read().startsWith(original)).toBe(true);
        expect(read()).toContain("port = 8234");
    });

    it("keeps a port the author already set instead of restating the default", () => {
        write("[ballerina.workflow.management.rest]\nport = 9999\nenableBasicAuth = true\n");

        enableWorkflowManagementConfig(projectPath);

        const config = parse(read()) as any;
        expect(config.ballerina.workflow.management.rest)
            .toEqual({ enableManagementApi: true, port: 9999, enableBasicAuth: true });
    });

    it("flips an existing false rather than adding a second key", () => {
        write("[ballerina.workflow.management.rest]\nenableManagementApi = false\nport = 9999\n");

        enableWorkflowManagementConfig(projectPath);

        expect(read()).toBe("[ballerina.workflow.management.rest]\nenableManagementApi = true\nport = 9999\n");
    });

    it("does not rewrite the file when the API is already enabled", () => {
        const original = "[ballerina.workflow.management.rest]\nenableManagementApi = true\nport = 9999\n";
        write(original);
        const before = fs.statSync(configPath).mtimeMs;

        enableWorkflowManagementConfig(projectPath);

        expect(read()).toBe(original);
        expect(fs.statSync(configPath).mtimeMs).toBe(before);
    });

    it("appends the table without swallowing a file that has no trailing newline", () => {
        write('[ballerina.workflow]\nmode = "IN_MEMORY"');

        enableWorkflowManagementConfig(projectPath);

        const config = parse(read()) as any;
        expect(config.ballerina.workflow.mode).toBe("IN_MEMORY");
        expect(config.ballerina.workflow.management.rest.enableManagementApi).toBe(true);
    });
});

describe("disableWorkflowManagementConfig", () => {
    it("removes the table it owns and nothing else", () => {
        write('[ballerina.workflow]\nmode = "LOCAL"\n\n[ballerina.workflow.management.rest]\nenableManagementApi = true\n');

        disableWorkflowManagementConfig(projectPath);

        expect(read()).not.toContain("management.rest");
        expect(parse(read()) as any).toEqual({ ballerina: { workflow: { mode: "LOCAL" } } });
    });

    it("keeps the table when the author has other settings in it", () => {
        write("[ballerina.workflow.management.rest]\nenableManagementApi = true\nport = 9999\n");

        disableWorkflowManagementConfig(projectPath);

        expect(read()).toBe("[ballerina.workflow.management.rest]\nport = 9999\n");
    });

    it("does nothing when there is no Config.toml", () => {
        disableWorkflowManagementConfig(projectPath);

        expect(fs.existsSync(configPath)).toBe(false);
    });

    it("does not rewrite a file that never had the key", () => {
        const original = '[ballerina.workflow]\nmode = "LOCAL"\n';
        write(original);
        const before = fs.statSync(configPath).mtimeMs;

        disableWorkflowManagementConfig(projectPath);

        expect(read()).toBe(original);
        expect(fs.statSync(configPath).mtimeMs).toBe(before);
    });
});
