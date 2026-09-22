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

// Imported from source rather than the package barrel, which pulls in ESM-only LS transports.
import { DIRECTORY_MAP, ProjectStructure } from "../../../ballerina-core/src/interfaces/bi";
import { hasWorkflowArtifacts } from "../../../ballerina-core/src/utils/identifier-utils";

function project(directoryMap: Record<string, any[]>): ProjectStructure {
    return { projectName: "approvalagent", directoryMap } as ProjectStructure;
}

const workflow = { id: "w1", name: "expenseApproval", path: "", type: DIRECTORY_MAP.WORKFLOW };
const aiAgent = { id: "a1", name: "chatAgent", path: "", type: DIRECTORY_MAP.AGENT };
const durableAgent = {
    id: "a2", name: "expenseApproval", path: "",
    type: DIRECTORY_MAP.AGENT, kind: DIRECTORY_MAP.DURABLE_AGENT,
};

describe("hasWorkflowArtifacts", () => {
    it("sees a plain workflow", () => {
        expect(hasWorkflowArtifacts(project({ [DIRECTORY_MAP.WORKFLOW]: [workflow] }))).toBe(true);
    });

    it("sees a durable agent, which is listed under AGENT but runs on the workflow engine", () => {
        expect(hasWorkflowArtifacts(project({ [DIRECTORY_MAP.AGENT]: [durableAgent] }))).toBe(true);
    });

    it("does not treat a plain AI agent as a workflow", () => {
        expect(hasWorkflowArtifacts(project({ [DIRECTORY_MAP.AGENT]: [aiAgent] }))).toBe(false);
    });

    it("picks the durable agent out from beside an AI agent", () => {
        expect(hasWorkflowArtifacts(project({ [DIRECTORY_MAP.AGENT]: [aiAgent, durableAgent] }))).toBe(true);
    });

    it("is false for a project with neither, and for no project at all", () => {
        expect(hasWorkflowArtifacts(project({ [DIRECTORY_MAP.SERVICE]: [{ id: "s1" }] }))).toBe(false);
        expect(hasWorkflowArtifacts(project({}))).toBe(false);
        expect(hasWorkflowArtifacts(undefined)).toBe(false);
    });
});
