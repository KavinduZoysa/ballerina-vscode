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

// The agent box is the one node whose link update is conditional, because the synthetic copy that
// floats above the chain must not join it. An `agent.run(...)` statement carries the same marker,
// so the conditions decide whether a real statement links at all (wso2/product-integrator#2472).

import { NodeFactoryVisitor } from "../visitors/NodeFactoryVisitor";
import { FlowNode, NodeKind } from "../utils/types";

function makeNode(id: string, kind: NodeKind, data?: Record<string, unknown>, startNodeId?: string): FlowNode {
    return {
        id,
        metadata: { label: kind, description: id, ...(data ? { data } : {}) },
        codedata: { node: kind, sourceCode: id },
        branches: [],
        returning: false,
        viewState: { x: 0, y: 0, lw: 0, rw: 0, h: 0, clw: 0, crw: 0, ch: 0, ...(startNodeId ? { startNodeId } : {}) },
    } as FlowNode;
}

const agentBox = (id: string, startNodeId?: string) => makeNode(id, "DURABLE_AGENT_RUN", { agentBox: true }, startNodeId);

describe("NodeFactoryVisitor agent run links", () => {
    it("links the statement that follows an agent run in a straight chain", () => {
        const visitor = new NodeFactoryVisitor();
        visitor.beginVisitEventStart(makeNode("start", "EVENT_START"));
        visitor.beginVisitDurableAgentRun(agentBox("run"));
        visitor.beginVisitNode(makeNode("after", "EXPRESSION"));

        const links = (visitor as any).links as Array<{ getSourcePort: () => { getNode: () => { getID: () => string } } }>;
        const sources = links.map((link) => link.getSourcePort().getNode().getID());
        expect(sources).toContain("run");
    });

    it("links an agent run that opens a branch, where there is no preceding node", () => {
        const visitor = new NodeFactoryVisitor();
        visitor.beginVisitEventStart(makeNode("start", "EVENT_START"));
        // A branch's first child carries the start it hangs from, and no last node is set.
        (visitor as any).lastNodeModel = undefined;
        visitor.beginVisitDurableAgentRun(agentBox("run-in-branch", "start"));
        visitor.beginVisitNode(makeNode("after", "EXPRESSION"));

        const links = (visitor as any).links as Array<{ getSourcePort: () => { getNode: () => { getID: () => string } } }>;
        const sources = links.map((link) => link.getSourcePort().getNode().getID());
        expect(sources).toContain("run-in-branch");
    });

    it("keeps the synthetic box above the chain out of it", () => {
        const visitor = new NodeFactoryVisitor();
        // The floating copy is visited before anything else: no preceding node and no start.
        visitor.beginVisitDurableAgentRun(agentBox("floating-box"));
        expect((visitor as any).links).toHaveLength(0);
        expect((visitor as any).lastNodeModel).toBeUndefined();
    });
});
